/**
 * The terminal itself. Thin on purpose: paints bytes and sends keys.
 *
 * The golden rule of §4.3 lives here — **attach before spawn**. Mounting this
 * component does not create a process; it asks the backend what exists and
 * only spawns if there is nothing. That's what makes HMR, UI reload and
 * layout switches painless for an agent in the middle of a task.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

import { broadcastLabel, broadcastTargets } from "../../lib/broadcast";
import { readClipboardText } from "../../lib/clipboard";
import {
  pickPastedImage,
  readClipboardImage,
  saveClipboardImage,
  type PastedImage,
} from "../../lib/clipboardImage";
import { AsyncDisposer } from "../../lib/disposables";
import { interceptFlowInput } from "../../lib/flowIntercept";
import { spawnEnvFor } from "../../lib/spawnEnv";
import { ipc, on, type SpawnOptions } from "../../lib/ipc";
import { ligatureRanges } from "../../lib/ligatures";
import { uiLog } from "../../lib/log";
import { baseName } from "../../lib/terminals";
import { openTermLink } from "../../lib/termLinkOpen";
import { termLinkProvider } from "../../lib/termLinkProvider";
import { useExtensions } from "../../stores/extensionsStore";
import { useProjects } from "../../stores/projectsStore";
import { useAdvertised } from "../../stores/advertisedStore";
import { useBroadcast } from "../../stores/broadcastStore";
import { feedTail, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import { resolvedTheme, useResolvedTheme } from "../../stores/themeStore";
import { t } from "../../lib/i18n";
import { TERM_WELL_VAR, termPaletteFor } from "../../lib/termTheme";

export interface XTermHandle {
  /** Spawns the process (used by the "resume" button). */
  start: (override?: Partial<SpawnOptions>) => Promise<void>;
  focus: () => void;
  fit: () => void;
  clear: () => void;
  /** Pastes the clipboard into the PTY (the menu's "Colar"). */
  paste: () => void;
  /** Columns the terminal currently shows — 0 before it has been laid out. */
  cols: () => number;
  findNext: (q: string) => void;
  findPrevious: (q: string) => void;
  /**
   * Incremental search — what the box calls on every keystroke. Without it the
   * count only existed after Enter, and a search with no result was
   * indistinguishable from a broken button.
   */
  findIncremental: (q: string) => void;
  /** Clears the highlights and returns the screen to normal (closing the box). */
  clearSearch: () => void;
  /** Who receives "result 3 of 12" on every change. `null` turns it off. */
  setSearchListener: (cb: SearchListener | null) => void;
}

/** `count` 0 = nothing found; `index` is 0-based, -1 before the first. */
export type SearchListener = (r: { index: number; count: number }) => void;

interface Props {
  id: string;
  program: string;
  args: string[];
  cwd: string;
  kind: "shell" | "agent";
  title: string;
  /** Spawns on its own at mount if there is no live process. */
  autoStart: boolean;
  visible: boolean;
  /**
   * Overrides the global font size for this instance only (canvas cards carry
   * their own — see `CanvasNode.fontSize`). Changing it reflows the PTY, which
   * is exactly the intent: bigger glyphs, fewer columns.
   */
  fontSize?: number;
  onFocus?: () => void;
  /**
   * Right-click over the terminal. The event never reaches the host through
   * React: it is stopped before xterm can see it (see the mount effect), so
   * whoever owns the menu has to be told here.
   */
  onContextMenu?: (e: MouseEvent) => void;
  style?: CSSProperties;
}

/**
 * Search highlighting in the scrollback.
 *
 * The decorations are not ornament: the addon **only publishes the result
 * count** when they are on, and that count is what answers "found 3 of 12"
 * or "found nothing" — the difference between a search that answers and an
 * Enter that does nothing. The colors come from the terminal's own cool
 * palette (selection and cursor blue), so the current match stands out from
 * the rest without becoming another interface.
 */
const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: "#2b446b",
    matchBorder: "#3f5f8f",
    matchOverviewRuler: "#5fa8ff",
    activeMatchBackground: "#3d6fb0",
    activeMatchBorder: "#8ec2ff",
    activeMatchColorOverviewRuler: "#8ec2ff",
  },
} as const;

/**
 * How long a paste stays authorized after the shortcut. Wide enough for the
 * browser to round-trip its own `paste` event, short enough that a stray
 * paste minutes later (a host menu, a mouse driver) finds the gate shut.
 */
const PASTE_INTENT_MS = 2000;

/**
 * How much replayed scrollback the URL scanner reads on attach. A startup
 * banner is at the top of the session, but the ring buffer can be 4 MB — this
 * is the compromise: enough for a server that started recently, cheap enough
 * to run on every mount.
 */
const SCAN_TAIL = 64 * 1024;

/**
 * Plain `Ctrl+<letter>` combinations the **window** owns (see
 * `hooks/useKeybindings.ts`). They have to be listed here because xterm turns
 * any of them into a control byte on the way to the PTY — the key would open
 * the panel *and* type into the CLI. Ctrl+Shift combinations are safe: xterm
 * only maps the no-modifier-but-Ctrl case.
 */
const WINDOW_KEYS = new Set(["KeyP", "KeyB", "KeyT"]);

/**
 * How long we wait for the pane to stop changing size before creating a
 * process. See `waitForLayout`.
 */
const LAYOUT_SETTLE_MS = 400;

/**
 * Silence required before a size change is pushed down to the PTY. Long enough
 * that a window drag lands as one reflow instead of a hundred, short enough
 * that letting go of the mouse feels immediate.
 */
const PTY_SETTLE_MS = 180;

/**
 * How often a terminal with no process behind it may say so. Typing a whole
 * sentence into a dead CLI is one mistake, not thirty toasts.
 */
const DEAD_HINT_MS = 6_000;
const deadHintAt = new Map<string, number>();

/**
 * Resolves once the host has held the same (non-zero) width for two frames in
 * a row, or once the deadline passes.
 *
 * **This is what keeps an agent CLI from being born squeezed.** A PTY takes its
 * columns at `openpty` and the CLI paints its banner immediately — from Ink's
 * static output, which is never redrawn. Whatever width the pane happened to
 * have in that instant is the width that box keeps for the rest of the
 * session. And the pane's width right after mount is not the final one: the
 * side panels are lazy (they occupy nothing until their chunk lands), the
 * window may still be settling into its restored geometry, and `App` may be
 * about to close a panel to make room. Half a dozen frames later everything
 * agrees — so we wait for that instead of measuring the first thing we see.
 *
 * The deadline matters as much as the loop: `requestAnimationFrame` does not
 * run while the window is minimized, and a terminal that never starts is worse
 * than one that starts narrow.
 */
function waitForLayout(host: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(finish, LAYOUT_SETTLE_MS);
    let previous = -1;
    let steady = 0;
    const step = () => {
      if (done) return;
      const width = host.clientWidth;
      steady = width > 0 && width === previous ? steady + 1 : 0;
      previous = width;
      if (steady >= 2) finish();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * A keystroke that reached no process.
 *
 * `write_pty` failing used to be swallowed, and there is exactly one way for a
 * user to find out: type a whole prompt into a terminal that looks alive
 * (scrollback on screen, cursor blinking) and watch nothing appear. It happens
 * after every restart — closing the app kills the process trees — so the write
 * itself is the last place that can still say it.
 *
 * Also writes the state down: whatever missed it on attach (a process that
 * died between the attach and the keystroke) is caught here, and the card
 * grows its "Retomar" banner instead of staying silent.
 */
function noteDeadWrite(id: string) {
  const runtimes = useTerminals.getState();
  const rt = runtimes.byId[id];
  if (rt?.state === "starting") return; // being born; the bytes were early
  if (rt?.state !== "exited" && rt?.state !== "error") {
    runtimes.markExited(id, null, "gone");
  }
  const last = deadHintAt.get(id) ?? 0;
  const now = performance.now();
  if (now - last < DEAD_HINT_MS) return;
  deadHintAt.set(id, now);
  const row = useProjects.getState().terminal(id);
  const name = row ? baseName(row) : t("Este CLI");
  useUI
    .getState()
    .showToast(t("{name} não está rodando — use Retomar para iniciar de novo.", { name }));
}

export const XTermView = forwardRef<XTermHandle, Props>(function XTermView(
  {
    id,
    program,
    args,
    cwd,
    kind,
    title,
    autoStart,
    visible,
    fontSize,
    onFocus,
    onContextMenu,
    style,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  /** Subscriber to the result count (the pane's search box). */
  const searchCbRef = useRef<SearchListener | null>(null);
  /** Prevents two simultaneous spawns (StrictMode mounts twice in dev). */
  const spawningRef = useRef(false);
  /**
   * The view is still rebuilding the screen it was born into (see the mount
   * effect). While this is up, nothing the terminal says goes to the process:
   * the scrollback being replayed carries the *process's own* startup queries
   * — `\e[6n` asking where the cursor is, `\e[?1004h` turning focus reports on
   * — and xterm answers them as if they had just been asked. Those answers are
   * bytes on the CLI's stdin: `\e[1;1R` and `\e[O` typed into the prompt of an
   * agent that asked nothing. That is a terminal talking to itself through
   * somebody else's keyboard.
   */
  const replayingRef = useRef(true);
  /**
   * When the user last *asked* to paste (`performance.now()`), or 0 when
   * nobody did. The gate in the mount effect only lets the clipboard through
   * while this is fresh — see the comment there.
   */
  const pasteIntentRef = useRef(0);
  /**
   * Size the backend was last told. Everything goes through `syncSize`, which
   * compares against this — see the comment there.
   */
  const sentSizeRef = useRef({ rows: 0, cols: 0 });

  // Subscribed one scalar at a time. `s.prefs` is rebuilt on every
  // `setPrefLocal`, which the sidebar splitter calls on every pointermove —
  // as an object subscription that re-renders every mounted terminal for the
  // whole length of the drag.
  const prefFontSize = useUI((s) => s.prefs.fontSize);
  const fontFamily = useUI((s) => s.prefs.fontFamily);
  const termLigatures = useUI((s) => s.prefs.termLigatures);
  const scrollback = useUI((s) => s.prefs.scrollback);
  const cursorBlink = useUI((s) => s.prefs.cursorBlink);

  // --- keyboard broadcast (lib/broadcast.ts) --------------------------------
  // Three scalars, so nothing here re-renders while the mode is off: the
  // armed group, whether it is *this* terminal's group, and — only then —
  // how many other CLIs are alive to receive the keystrokes.
  const broadcastGroup = useBroadcast((s) => s.groupId);
  const broadcasting = useProjects((s) =>
    broadcastGroup !== null &&
    s.terminals.find((t) => t.id === id)?.groupId === broadcastGroup,
  );
  const broadcastCount = useTerminals((s) =>
    broadcasting && broadcastGroup
      ? broadcastTargets(useProjects.getState().terminals, s.byId, id, broadcastGroup).length
      : -1,
  );
  // The strip is imperative DOM, not a React child: xterm owns the host's
  // children (`term.open(host)`), and a React node reconciled next to them
  // is one re-render away from an `insertBefore` on a node React never made.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !broadcasting) return;
    const strip = document.createElement("div");
    strip.className = "xterm-broadcast";
    strip.setAttribute("role", "status");
    strip.textContent = broadcastLabel(broadcastCount);
    host.appendChild(strip);
    return () => strip.remove();
  }, [broadcasting, broadcastCount]);
  const px = fontSize ?? prefFontSize;

  // Props that `start` needs without entering the mount-effect
  // dependencies — remounting xterm on every render would be catastrophic.
  const spawnArgs = useRef({ program, args, cwd, kind, title });
  spawnArgs.current = { program, args, cwd, kind, title };

  // Same reason: the mount effect installs the mouse listeners once and must
  // still call whatever the current render passed down.
  const cbRef = useRef({ onFocus, onContextMenu });
  cbRef.current = { onFocus, onContextMenu };

  /**
   * Puts an image into the PTY the only way a PTY takes one: as the path of a
   * file on disk. The agent CLIs recognize an image path inside a paste and
   * attach the picture themselves (see `lib/clipboardImage.ts`).
   */
  const pasteImage = (image: PastedImage) => {
    void saveClipboardImage(image)
      .then((path) => termRef.current?.paste(path))
      .catch((e) => {
        useUI.getState().showToast(t("Não consegui colar a imagem: {reason}", { reason: String(e) }), "error");
      });
  };

  /**
   * Pastes by reading the clipboard by hand — what the menu's "Colar" and the
   * Ctrl+V fallback use. `term.paste` (and not `writePty`) is what wraps the
   * text in the bracketed-paste markers the CLI expects, so a multi-line
   * prompt arrives as text instead of as a burst of Enters.
   *
   * `report` says whether coming back empty deserves a toast: the menu entry
   * did nothing visible and owes the user an explanation, the keyboard
   * fallback already had the browser's own paste as a first chance.
   */
  const pasteFromClipboard = (report: boolean) => {
    const term = termRef.current;
    if (!term) return;
    void readClipboardText().then(async (text) => {
      if (text) {
        term.paste(text);
        return;
      }
      // No text does not mean nothing: a screenshot is the usual reason the
      // clipboard has no text at all. Asking the host for the image is a
      // second permission that may also be denied — hence the fall-through.
      const image = await readClipboardImage();
      if (image) {
        pasteImage(image);
        return;
      }
      if (!report) return;
      // `null` is the host refusing to read; `""` is a clipboard with nothing
      // we can use — different problems, different advice.
      useUI
        .getState()
        .showToast(
          text == null
            ? t("sem acesso à área de transferência — use Ctrl+V")
            : t("não há texto nem imagem na área de transferência"),
          text == null ? "error" : "info",
        );
    });
  };

  /**
   * Opens the gate for the paste the user just asked for, and covers the case
   * where the browser's own paste never comes (nothing focused to paste into,
   * an empty clipboard): one turn later, if the gate is still open, read the
   * clipboard by hand.
   */
  const armPaste = () => {
    pasteIntentRef.current = performance.now();
    setTimeout(() => {
      if (!pasteIntentRef.current) return; // the `paste` event already served it
      pasteIntentRef.current = 0;
      pasteFromClipboard(false);
    }, 0);
  };

  /**
   * Reports the terminal's size to the backend — **only when it changed**.
   *
   * Every reflow makes conhost redraw its buffer and re-emit the visible
   * frame, on top of whatever the application is painting. Sending the same
   * size on every `ResizeObserver` tick of a window drag is how a full-screen
   * TUI ends up with half-drawn boxes. The backend has the same guard; this one
   * also saves the IPC round-trip.
   *
   * The failure branch is the other half: `resizePty` rejects while the PTY
   * does not exist yet, and swallowing that used to leave the terminal
   * permanently out of sync — `ResizeObserver` does not fire again on its own
   * without a *new* size change. Forgetting what we "sent" is what makes the
   * next tick (visibility, font change, another drag) repair it.
   */
  const syncSize = () => {
    const term = termRef.current;
    if (!term || !term.rows || !term.cols) return;
    const next = { rows: term.rows, cols: term.cols };
    const sent = sentSizeRef.current;
    if (sent.rows === next.rows && sent.cols === next.cols) return;
    sentSizeRef.current = next;
    void ipc.resizePty(id, next.rows, next.cols).catch(() => {
      // Only if nothing newer went out in the meantime: a send that failed
      // while the process was still being created must not invalidate the
      // size the spawn itself already carried.
      const cur = sentSizeRef.current;
      if (cur.rows === next.rows && cur.cols === next.cols) {
        sentSizeRef.current = { rows: 0, cols: 0 };
      }
    });
  };

  const doStart = async (override?: Partial<SpawnOptions>) => {
    if (spawningRef.current) return;
    const term = termRef.current;
    if (!term) return;
    spawningRef.current = true;
    const store = useTerminals.getState();
    store.markStarting(id);
    try {
      // The pane is still settling at this point — lazy side panels, the
      // window arriving at its restored geometry, `App` closing a panel to
      // make room. Measuring the first frame is how a CLI ends up painting its
      // banner at 31 columns and keeping it there forever (see `waitForLayout`).
      if (hostRef.current) await waitForLayout(hostRef.current);
      if (!termRef.current) return; // unmounted while we waited
      try {
        fitRef.current?.fit();
      } catch {
        /* host still has no size */
      }
      const cur = spawnArgs.current;
      const snap = await ipc.spawnPty({
        id,
        program: cur.program,
        args: cur.args,
        cwd: cur.cwd,
        rows: term.rows,
        cols: term.cols,
        kind: cur.kind,
        title: cur.title,
        keepScrollback: true,
        // Read now, not stored on the row: a PTY fixes its environment at
        // spawn, so changing the cache setting applies on the next restart
        // (`lib/spawnEnv.ts`).
        env: spawnEnvFor(id),
        ...override,
      });
      store.markRunning(id, snap.pid);
      // The process already has these columns — `spawnPty` carried them. Say
      // so, or the sync below would push a reflow at a CLI that is drawing its
      // first frame.
      sentSizeRef.current = { rows: snap.rows, cols: snap.cols };
      // A resize fired while spawn was running found "pty doesn't exist" and
      // was swallowed — and ResizeObserver doesn't fire again without a size
      // change. Sync the pane's real size now that the PTY exists.
      try {
        fitRef.current?.fit();
      } catch {
        /* same */
      }
      syncSize();
      uiLog.info(
        `pty ${id} iniciado: ${cur.program} pid=${snap.pid ?? "?"} ` +
          `${snap.cols}x${snap.rows}`,
      );
    } catch (e) {
      const msg = String(e);
      store.markError(id, msg);
      uiLog.error(`falha ao iniciar pty ${id}: ${msg}`);
      term.write(`\r\n\x1b[31m${t("[yard] falha ao iniciar: {reason}", { reason: msg })}\x1b[0m\r\n`); // i18n-ok
    } finally {
      spawningRef.current = false;
    }
  };

  useImperativeHandle(ref, () => ({
    start: doStart,
    focus: () => termRef.current?.focus(),
    fit: () => fitRef.current?.fit(),
    paste: () => {
      termRef.current?.focus();
      pasteFromClipboard(true);
    },
    cols: () => termRef.current?.cols ?? 0,
    clear: () => {
      termRef.current?.clear();
      // Swallowing this made the button a silent no-op: the screen went blank
      // while the scrollback stayed on disk and came back on the next reload.
      void ipc.clearPty(id).catch((e) => {
        useUI
          .getState()
          .showToast(
            t("Limpei a tela, mas não consegui apagar o histórico no disco: {reason}", { reason: String(e) }),
            "error",
          );
      });
    },
    findNext: (q) => searchRef.current?.findNext(q, SEARCH_OPTIONS),
    findPrevious: (q) => searchRef.current?.findPrevious(q, SEARCH_OPTIONS),
    // `incremental` keeps the current match while the term grows, instead of
    // jumping to the next one on every keystroke.
    findIncremental: (q) =>
      searchRef.current?.findNext(q, { ...SEARCH_OPTIONS, incremental: true }),
    clearSearch: () => searchRef.current?.clearDecorations(),
    setSearchListener: (cb) => {
      searchCbRef.current = cb;
    },
  }));

  // --- mount: create xterm, attach, listen for events ---
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Every mount starts by rebuilding a screen, and stays quiet until it has.
    replayingRef.current = true;

    // Read imperatively: this effect only runs on mount (deps are `[id]`), so
    // a subscription here would buy nothing and cost a render per change.
    const boot = useUI.getState().prefs;

    const term = new Terminal({
      fontFamily: boot.fontFamily,
      fontSize: fontSize ?? boot.fontSize,
      scrollback: boot.scrollback,
      cursorBlink: boot.cursorBlink,
      allowProposedApi: true,
      macOptionIsMeta: false,
      // The active color-scheme extension recolors the well; the effect below
      // keeps it hot, this only spares one repaint on mount.
      theme: termPaletteFor(
        useExtensions.getState().scheme.terminal,
        resolvedTheme(),
      ),
      // ConPTY repositions a lot; letting xterm convert \n to \r\n
      // avoids the "staircase" in tools that emit only LF.
      convertEol: false,
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Ctrl+click on a printed address or file path (`lib/termLinkProvider.ts`,
    // matcher in `lib/termLinks.ts`, destination in `lib/termLinkOpen.ts`).
    // Disposed with the terminal.
    term.registerLinkProvider(termLinkProvider(term, (match) => openTermLink(id, match)));

    term.open(host);

    // Renderer: canvas by default. WebGL works in WebView2 but not on
    // every GPU/driver — if it fails, canvas is already in effect.
    if (boot.renderer === "webgl") {
      void import("@xterm/addon-webgl")
        .then(({ WebglAddon }) => {
          try {
            const addon = new WebglAddon();
            addon.onContextLoss(() => addon.dispose());
            term.loadAddon(addon);
          } catch (e) {
            console.warn("[yard] WebGL indisponivel, usando canvas", e);
            term.loadAddon(new CanvasAddon());
          }
        })
        .catch(() => term.loadAddon(new CanvasAddon()));
    } else {
      term.loadAddon(new CanvasAddon());
    }

    try {
      fit.fit();
    } catch {
      /* host still has no size; ResizeObserver will fix it */
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // The count arrives by event (the addon scans in slices); whoever has the
    // box open receives it. `resultIndex` is -1 before the first match and
    // `resultCount` -1 when the term exceeds the highlight cap.
    const resultsListener = search.onDidChangeResults((r) =>
      searchCbRef.current?.({ index: r.resultIndex, count: r.resultCount }),
    );

    // Ctrl+C copies when there is a selection (the Windows expectation) and
    // only becomes interrupt when nothing is selected.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const ctrl = ev.ctrlKey && !ev.altKey;

      // Tab switching belongs to the window. Without returning `false` here
      // xterm would still send \t (Ctrl+Tab) or the Ctrl+2..8 control char to
      // the PTY before the global shortcut runs — the key would do both things.
      if (ev.ctrlKey && ev.code === "Tab") return false;
      if (ctrl && !ev.shiftKey && /^Digit[1-9]$/.test(ev.code)) return false;
      // Ctrl+Shift+1..6 focuses another pane — a window gesture, like the tab
      // switching above; the PTY has no use for it.
      if (ctrl && ev.shiftKey && /^Digit[1-6]$/.test(ev.code)) return false;
      // Search and shortcut map: window keys, not PTY keys.
      if (ctrl && ev.shiftKey && (ev.code === "KeyF" || ev.code === "KeyH"))
        return false;
      // The panel shortcuts, for the same reason and with a sharper edge: a
      // plain `Ctrl+letter` becomes a control byte (xterm sends
      // `keyCode - 64`), so `Ctrl+P` opened the search palette *and* typed ^P into the
      // shell — which in readline/PSReadLine recalls the previous command and
      // leaves it sitting on the prompt line, one Enter away from running.
      if (ctrl && !ev.shiftKey && WINDOW_KEYS.has(ev.code)) return false;
      // Ctrl+Enter opens the prompt composer. Without returning here, xterm
      // would send a \r to the PTY first — the agent would get an empty submit
      // every time the user went to write a long prompt.
      if (ctrl && !ev.shiftKey && (ev.code === "Enter" || ev.code === "NumpadEnter"))
        return false;
      // Ctrl+Shift+Enter opens the prompt window for this CLI — same reason:
      // without this, xterm would submit whatever is on the line first.
      if (ctrl && ev.shiftKey && (ev.code === "Enter" || ev.code === "NumpadEnter"))
        return false;
      if (ctrl && ev.shiftKey && ev.code === "KeyC") {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (ctrl && ev.code === "KeyC" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Paste (Ctrl+V, Ctrl+Shift+V, Shift+Insert): only stamps the intent and
      // lets the browser do its own paste — its `paste` event carries the text
      // without asking WebView2 for the clipboard-read permission the main
      // window never got. Returning false is still needed so xterm doesn't
      // send ^V to the PTY on the way.
      if ((ctrl && ev.code === "KeyV") || (ev.shiftKey && ev.code === "Insert")) {
        armPaste();
        return false;
      }
      return true;
    });

    /**
     * A paste is served only when the user asked for one.
     *
     * xterm listens for `paste` on its own element *and* on the hidden
     * textarea it parks under the mouse on every right click, and writes
     * whatever arrives straight to the PTY. That is how right-clicking a card
     * dumped the clipboard into the agent's prompt: the host pasted into that
     * textarea and the terminal never asked who wanted it. Taking the event in
     * the capture phase keeps xterm from ever seeing it; `armPaste` is the
     * only way through.
     */
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const asked =
        pasteIntentRef.current > 0 &&
        performance.now() - pasteIntentRef.current < PASTE_INTENT_MS;
      pasteIntentRef.current = 0;
      if (!asked) {
        uiLog.debug(`colagem ignorada em ${id}: ninguem pediu (clique direito?)`);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        term.paste(text);
        return;
      }
      // Nothing to paste as text is exactly what a screenshot looks like:
      // WebView2 hands the picture over in the same event, as a `File`. It
      // goes to disk and the terminal receives the path — which is what the
      // agent CLIs know how to open. Copying a *text* selection from a page
      // also carries an image sometimes, and that is why text wins above.
      const image = pickPastedImage(e.clipboardData);
      if (image) pasteImage(image);
    };
    host.addEventListener("paste", onPaste, true);

    /**
     * The right button belongs to the card's menu, never to the terminal.
     *
     * Swallowed before xterm sees it: it would park its hidden textarea under
     * the cursor (the seat the stray paste above lands in) and, with mouse
     * tracking on, report the button to the PTY. `contextmenu` goes to the
     * host's own handler instead of bubbling as a React event — stopping the
     * propagation here is what keeps xterm out of it.
     */
    const onRightButton = (e: MouseEvent) => {
      if (e.button !== 2) return;
      // Only the propagation: `preventDefault` on the button's own events is
      // what would cost the terminal its keyboard focus (and, on Windows, it
      // is not what suppresses the host menu — the `contextmenu` below is).
      e.stopPropagation();
      term.focus();
      cbRef.current.onFocus?.();
    };
    host.addEventListener("mousedown", onRightButton, true);
    host.addEventListener("mouseup", onRightButton, true);
    host.addEventListener("auxclick", onRightButton, true);

    const onCtx = (e: MouseEvent) => {
      // Also keeps the host WebView2 from showing "Inspecionar / Copiar
      // imagem" — and, with it, the "Colar" that wrote into the PTY.
      e.preventDefault();
      e.stopPropagation();
      cbRef.current.onFocus?.();
      cbRef.current.onContextMenu?.(e);
    };
    host.addEventListener("contextmenu", onCtx, true);

    const subscriptions = new AsyncDisposer((error) => {
      uiLog.warn(`falha ao remover listener do terminal ${id}: ${error}`);
    });

    /**
     * Live output that arrived while the screen was still being rebuilt.
     *
     * The two halves come down different pipes: output is an event, the
     * history is the answer to a command. Nothing orders them — and the
     * history loses the race often, because it is up to 4 MB of JSON while a
     * chunk of output is a few hundred bytes. Painting it whenever it lands
     * means painting **stale bytes over fresh ones**: the frame the CLI just
     * drew, buried under the log of how it got there. That is the black pane.
     */
    const held: string[] = [];
    const paintLive = (data: string) => {
      if (replayingRef.current) held.push(data);
      else term.write(data);
    };
    /** The screen is rebuilt: unmute the keyboard and let the live bytes in. */
    const doneRebuilding = () => {
      if (!replayingRef.current || subscriptions.disposed) return;
      replayingRef.current = false;
      for (const chunk of held.splice(0)) term.write(chunk);
    };

    void (async () => {
      const store = useTerminals.getState();

      await Promise.all([
        subscriptions.add(on.output(id, (p) => {
          paintLive(p.data);
          // "Local: http://localhost:5173" — the address a dev server prints
          // becomes a portal the user can open with one click.
          useAdvertised.getState().ingest(id, p.data);
          // The last bytes, kept raw. Read once per idle event to tell an
          // agent that finished from one stopped at a question.
          feedTail(id, p.data);
          const ui = useUI.getState();
          if (ui.focusedTerminalId !== id) {
            useTerminals.getState().patch(id, { unread: true });
          }
        })),
        // Only the *painting* half of the exit lives here. Marking the state,
        // dropping the tail and forgetting the announced addresses is
        // `lib/ptyWatch.ts`, which listens for every terminal in the workspace
        // — including the ones with no pane mounted, which is exactly where
        // this used to go silent.
        subscriptions.add(on.exit(id, (p) => {
          const label =
            p.reason === "suspended"
              ? "suspenso"
              : p.reason === "restarted"
                ? "reiniciando"
                : p.reason === "killed"
                  ? "encerrado"
                  : `saiu${p.code != null ? ` (codigo ${p.code})` : ""}`;
          paintLive(`\r\n\x1b[90m[processo ${label}]\x1b[0m\r\n`);
        })),
      ]);

      if (subscriptions.disposed) return;

      // Attach first. If the PTY exists (reload/HMR/layout switch), just
      // repaint; if not, decide between spawning or waiting for the user.
      const attached = await ipc.attachPty(id);
      if (subscriptions.disposed) return;

      uiLog.debug(
        `attach ${id}: vivo=${attached.alive} bytes=${attached.data.length} ` +
          `alt=${attached.altScreen} saida=${attached.exit?.reason ?? "-"} ` +
          `autoStart=${autoStart}`,
      );

      // Dead and with auto-start (app boot, respawn after exit): the new
      // process starts with a clean screen. Dead scrollback carries positioning
      // sequences recorded at a *different* screen size — replaying that
      // leaves blank lines at the top and the prompt in the middle of the pane.
      // Replay is for the cases where it's faithful: a live process (reload/HMR,
      // same buffer) and a manual "Resume" after suspend (no spawn until the click).
      const freshBoot = !attached.alive && autoStart;

      /**
       * A live full-screen CLI is asked for its screen; everything else has
       * its screen rebuilt from the log.
       *
       * The scrollback of an agent is not a history of *lines*, it is a
       * history of *edits* to one frame — "erase to end of line, cursor to
       * 50;3, three cells" — and every one of them assumes the frame that
       * preceded it, at the width it was drawn at. Replay that into a pane of
       * another size (which is exactly what leaving the canvas is) and almost
       * nothing lands: measured on a real session, 6 of 40 rows survive. The
       * pane goes black and the CLI never redraws it, because from its side
       * nothing happened.
       *
       * The console host, on the other hand, has the frame — and hands it over
       * on any size change. So: ask, don't guess.
       */
      const askForFrame = attached.alive && attached.altScreen;
      const rebuild = askForFrame
        ? // Land where the CLI thinks it is drawing. Without this the frame
          // arrives into the normal buffer and scrolls the pane instead of
          // painting it.
          "\x1b[?1049h"
        : attached.data && !freshBoot
          ? attached.data
          : "";
      // The callback is what makes the ordering real: live output waits in
      // `held` until the last byte of this has been parsed.
      if (rebuild) term.write(rebuild, doneRebuilding);
      else doneRebuilding();

      // The scanner only sees what arrives while this view is mounted, and a
      // dev server announces itself once, at boot — very likely before anyone
      // opened the pane. The tail of the replayed scrollback closes that gap.
      if (attached.alive && attached.data) {
        useAdvertised.getState().ingest(id, attached.data.slice(-SCAN_TAIL));
        // Same gap for the blocked detector, and worse: an agent can sit at a
        // prompt for an hour, so the pane is very likely to be opened *after*
        // the question was asked.
        feedTail(id, attached.data.slice(-SCAN_TAIL));
      }

      if (attached.alive) {
        store.markRunning(id, attached.pid);
        // What the process is on right now. Seeding with it means a reload or
        // an HMR round only reflows when the pane really is a different size —
        // and, when it is, `syncSize` sends it instead of assuming the backend
        // already knows.
        sentSizeRef.current = { rows: attached.rows, cols: attached.cols };
        syncSize();
        if (askForFrame) {
          void ipc.repaintPty(id).catch((e) => {
            uiLog.warn(`nao consegui pedir a tela de ${id}: ${e}`);
          });
        }
      } else if (attached.exit) {
        store.markExited(id, attached.exit.code, attached.exit.reason);
        if (autoStart) void doStart({ keepScrollback: false });
      } else if (autoStart) {
        void doStart({ keepScrollback: false });
      } else {
        // No process, no exit on record, and nobody asked to start it: the
        // app was closed and its trees went with it (§F3), and this session
        // has never seen this id.
        //
        // Saying so is the whole point. The scrollback above just painted a
        // terminal that looks exactly like a live one — same prompt, same
        // cursor — and the state that would tell the truth (the runtime
        // entry) does not exist, so no badge, no banner, and every keystroke
        // going into a `write_pty` that fails and is swallowed. That is
        // "I reopened the app and can no longer type into the CLI".
        store.markExited(id, null, "gone");
      }
    })().catch((error) => {
      if (subscriptions.disposed) return;
      // Whatever went wrong, the terminal cannot stay muted and holding
      // output forever.
      doneRebuilding();
      uiLog.error(`falha ao anexar terminal ${id}: ${error}`);
      useTerminals.getState().markError(id, String(error));
    });

    const onData = term.onData((data) => {
      // Answers to questions nobody asked (see `replayingRef`).
      if (replayingRef.current) return;
      // Flow mode: in a CLI wired to a flow, Enter with text is consumed —
      // the pipeline takes over the request and submits it with stage 1
      // attached. Everything else passes untouched (see `lib/flowIntercept.ts`).
      if (interceptFlowInput(id, data)) return;
      // Keyboard broadcast: the same keystroke goes to every other live CLI
      // of the armed group (lib/broadcast.ts). Read from the store, not from
      // a closure — this effect mounts once per terminal and the mode toggles
      // many times after that.
      const armed = useBroadcast.getState().groupId;
      if (armed && useProjects.getState().terminal(id)?.groupId === armed) {
        const targets = broadcastTargets(
          useProjects.getState().terminals,
          useTerminals.getState().byId,
          id,
          armed,
        );
        for (const target of targets) void ipc.writePty(target, data).catch(() => {});
      }
      void ipc.writePty(id, data).catch(() => noteDeadWrite(id));
    });
    const onBinary = term.onBinary((data) => {
      if (replayingRef.current) return;
      void ipc
        .writePty(
          id,
          Array.from(data, (c) => String.fromCharCode(c.charCodeAt(0) & 255)).join(""),
        )
        .catch(() => {});
    });

    // Resize, in two speeds.
    //
    // `fit` is local and cheap, so it runs fast (a frame for layout plus a
    // ~50 ms debounce) and the terminal keeps up with the pane. Telling the
    // **PTY** is a different matter: each reflow makes conhost repaint its
    // buffer over whatever the application was drawing, and dragging a window
    // edge crosses a column boundary every few pixels. Sending each of those
    // is what leaves an agent CLI with half-drawn boxes. So that half only
    // fires once the gesture stops — one reflow, at the size that lasts.
    let raf = 0;
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(() => {
          if (
            subscriptions.disposed ||
            host.clientWidth === 0 ||
            host.clientHeight === 0
          ) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          if (syncTimer) clearTimeout(syncTimer);
          syncTimer = setTimeout(() => {
            if (subscriptions.disposed) return;
            syncSize();
          }, PTY_SETTLE_MS);
        }, 50);
      });
    });
    ro.observe(host);

    return () => {
      subscriptions.dispose();
      cancelAnimationFrame(raf);
      if (fitTimer) clearTimeout(fitTimer);
      if (syncTimer) clearTimeout(syncTimer);
      ro.disconnect();
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("mousedown", onRightButton, true);
      host.removeEventListener("mouseup", onRightButton, true);
      host.removeEventListener("auxclick", onRightButton, true);
      host.removeEventListener("contextmenu", onCtx, true);
      onData.dispose();
      onBinary.dispose();
      resultsListener.dispose();
      term.dispose();
      termRef.current = null;
      // Does NOT call kill_pty: closing the view never kills the process (§4.3).
    };
    // Remounting the terminal only makes sense if the id changes. Font
    // preferences are applied by the next effect, without destroying the buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // --- preferences applied hot ---
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = px;
    term.options.fontFamily = fontFamily;
    term.options.scrollback = scrollback;
    term.options.cursorBlink = cursorBlink;
    try {
      fitRef.current?.fit();
      syncSize();
    } catch {
      /* ignore */
    }
  }, [id, px, fontFamily, scrollback, cursorBlink]);

  // --- color scheme (the Extensions store), applied hot like the prefs ---
  const schemeId = useExtensions((s) => s.scheme.terminal);
  // The light appearance swaps the well's palette the same way (a scheme
  // extension still wins over both — it is the user's explicit choice).
  const resolved = useResolvedTheme();
  const palette = termPaletteFor(schemeId, resolved);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = palette;
  }, [id, palette]);

  // --- sixel/iTerm images (extension): loaded in place, dropped in place ---
  const termImages = useExtensions((s) => s.enabled["term-images"] === true);
  useEffect(() => {
    const term = termRef.current;
    if (!term || !termImages) return;
    let alive = true;
    let addon: { dispose(): void } | null = null;
    void import("@xterm/addon-image")
      .then(({ ImageAddon }) => {
        if (!alive || !termRef.current) return;
        const a = new ImageAddon();
        term.loadAddon(a);
        addon = a;
      })
      .catch((e) => console.warn("[yard] addon de imagem indisponível", e));
    return () => {
      alive = false;
      try {
        addon?.dispose();
      } catch {
        /* the terminal died first — the addon went with it */
      }
    };
  }, [id, termImages]);

  // --- ligatures: sequences like `=>` drawn as one unit ---
  // The canvas/WebGL renderers paint per cell, so no font could ever form a
  // ligature on its own; a character joiner hands them whole ranges instead
  // (see `lib/ligatures.ts`). Registered only while the preference is on —
  // the joiner runs on every painted row.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !termLigatures) return;
    const joiner = term.registerCharacterJoiner(ligatureRanges);
    const repaint = () => {
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* disposed mid-toggle */
      }
    };
    repaint();
    return () => {
      try {
        term.deregisterCharacterJoiner(joiner);
      } catch {
        // Unmount disposes the terminal in the mount effect's cleanup; this
        // one may run after and the joiner died with the instance.
        return;
      }
      repaint();
    };
  }, [id, termLigatures]);

  // --- visibility: a hidden pane drops to 1 emission/450 ms (§5.3) ---
  useEffect(() => {
    void ipc.setPtyVisible(id, visible).catch(() => {});
    if (visible) {
      const t = setTimeout(() => {
        try {
          fitRef.current?.fit();
          syncSize();
        } catch {
          /* ignore */
        }
      }, 30);
      return () => clearTimeout(t);
    }
  }, [id, visible]);

  return (
    <div
      ref={hostRef}
      className="xterm-host"
      // The gutter around the canvas paints the same background xterm just
      // opened on, so nothing frames the text (see `.xterm-host`).
      style={{ ...style, [TERM_WELL_VAR]: palette.background } as CSSProperties}
      // Left button only: the right one is handled (and stopped) in the
      // capture listener installed at mount.
      onMouseDown={onFocus}
    />
  );
});

export default XTermView;
