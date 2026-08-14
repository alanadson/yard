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

import { ipc, on, type SpawnOptions, type UnlistenFn } from "../../lib/ipc";
import { uiLog } from "../../lib/log";
import { markActivity, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";

export interface XTermHandle {
  /** Spawns the process (used by the "resume" button). */
  start: (override?: Partial<SpawnOptions>) => Promise<void>;
  focus: () => void;
  fit: () => void;
  clear: () => void;
  /** Columns the terminal currently shows — 0 before it has been laid out. */
  cols: () => number;
  findNext: (q: string) => void;
  findPrevious: (q: string) => void;
}

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
  style?: CSSProperties;
}

// Dark premium macOS, matching the chrome (styles.css): the background is the
// panel's terminal well (#121215), cursor and selection in system blue. ANSI
// colors keep their semantics (blue stays blue inside the terminal), tuned for
// the cold ground without shouting over it.
const THEME = {
  background: "#121215",
  foreground: "#d9d9de",
  cursor: "#8ec2ff",
  cursorAccent: "#121215",
  selectionBackground: "#2b446b",
  black: "#1d1d22",
  red: "#ff6e64",
  green: "#5bd57f",
  yellow: "#eac95c",
  blue: "#5fa8ff",
  magenta: "#c98bf2",
  cyan: "#5fd2d2",
  white: "#d9d9de",
  brightBlack: "#7a7a85",
  brightRed: "#ff958d",
  brightGreen: "#8ce3a4",
  brightYellow: "#f2da8a",
  brightBlue: "#8fc2ff",
  brightMagenta: "#dcb0f7",
  brightCyan: "#8ce0e0",
  brightWhite: "#f7f7f9",
};

export const XTermView = forwardRef<XTermHandle, Props>(function XTermView(
  { id, program, args, cwd, kind, title, autoStart, visible, fontSize, onFocus, style },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  /** Prevents two simultaneous spawns (StrictMode mounts twice in dev). */
  const spawningRef = useRef(false);

  // Subscribed one scalar at a time. `s.prefs` is rebuilt on every
  // `setPrefLocal`, which the sidebar splitter calls on every pointermove —
  // as an object subscription that re-renders every mounted terminal for the
  // whole length of the drag.
  const prefFontSize = useUI((s) => s.prefs.fontSize);
  const fontFamily = useUI((s) => s.prefs.fontFamily);
  const scrollback = useUI((s) => s.prefs.scrollback);
  const cursorBlink = useUI((s) => s.prefs.cursorBlink);
  const px = fontSize ?? prefFontSize;

  // Props that `start` needs without entering the mount-effect
  // dependencies — remounting xterm on every render would be catastrophic.
  const spawnArgs = useRef({ program, args, cwd, kind, title });
  spawnArgs.current = { program, args, cwd, kind, title };

  const doStart = async (override?: Partial<SpawnOptions>) => {
    if (spawningRef.current) return;
    const term = termRef.current;
    if (!term) return;
    spawningRef.current = true;
    const store = useTerminals.getState();
    store.markStarting(id);
    try {
      // The host may have gained size after mount (initial fit without
      // layout); measuring now avoids creating a 24-line ConPTY in a pane
      // that actually has 45.
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
        ...override,
      });
      store.markRunning(id, snap.pid);
      // A resize fired while spawn was running found "pty doesn't exist" and
      // was swallowed — and ResizeObserver doesn't fire again without a size
      // change. Sync the pane's real size now that the PTY exists.
      try {
        fitRef.current?.fit();
      } catch {
        /* same */
      }
      void ipc.resizePty(id, term.rows, term.cols).catch(() => {});
      uiLog.info(`pty ${id} iniciado: ${cur.program} pid=${snap.pid ?? "?"}`);
    } catch (e) {
      const msg = String(e);
      store.markError(id, msg);
      uiLog.error(`falha ao iniciar pty ${id}: ${msg}`);
      term.write(`\r\n\x1b[31m[yard] falha ao iniciar: ${msg}\x1b[0m\r\n`);
    } finally {
      spawningRef.current = false;
    }
  };

  useImperativeHandle(ref, () => ({
    start: doStart,
    focus: () => termRef.current?.focus(),
    fit: () => fitRef.current?.fit(),
    cols: () => termRef.current?.cols ?? 0,
    clear: () => {
      termRef.current?.clear();
      void ipc.clearPty(id).catch(() => {});
    },
    findNext: (q) => searchRef.current?.findNext(q),
    findPrevious: (q) => searchRef.current?.findPrevious(q),
  }));

  // --- mount: create xterm, attach, listen for events ---
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
      theme: THEME,
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
      // Search and shortcut map: window keys, not PTY keys.
      if (ctrl && ev.shiftKey && (ev.code === "KeyF" || ev.code === "KeyH"))
        return false;
      // Ctrl+Enter opens the prompt composer. Without returning here, xterm
      // would send a \r to the PTY first — the agent would get an empty submit
      // every time the user went to write a long prompt.
      if (ctrl && !ev.shiftKey && (ev.code === "Enter" || ev.code === "NumpadEnter"))
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
      if (ctrl && (ev.code === "KeyV" || (ev.shiftKey && ev.code === "KeyV"))) {
        void navigator.clipboard.readText().then((text) => {
          if (text) void ipc.writePty(id, text);
        });
        return false;
      }
      return true;
    });

    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    void (async () => {
      const store = useTerminals.getState();

      unlisteners.push(
        await on.output(id, (p) => {
          term.write(p.data);
          const ui = useUI.getState();
          if (ui.focusedTerminalId !== id) {
            useTerminals.getState().patch(id, { unread: true });
          }
        }),
        await on.exit(id, (p) => {
          store.markExited(id, p.code, p.reason);
          const rotulo =
            p.reason === "suspended"
              ? "suspenso"
              : p.reason === "restarted"
                ? "reiniciando"
                : p.reason === "killed"
                  ? "encerrado"
                  : `saiu${p.code != null ? ` (codigo ${p.code})` : ""}`;
          term.write(`\r\n\x1b[90m[processo ${rotulo}]\x1b[0m\r\n`);
        }),
        await on.activity(id, (p) => {
          markActivity(id, p.lastByteAt, p.idleMs);
        }),
      );

      if (disposed) return;

      // Attach first. If the PTY exists (reload/HMR/layout switch), just
      // repaint; if not, decide between spawning or waiting for the user.
      const attached = await ipc.attachPty(id);
      if (disposed) return;

      uiLog.debug(
        `attach ${id}: vivo=${attached.alive} bytes=${attached.data.length} ` +
          `saida=${attached.exit?.reason ?? "-"} autoStart=${autoStart}`,
      );

      // Dead and with auto-start (app boot, respawn after exit): the new
      // process starts with a clean screen. Dead scrollback carries positioning
      // sequences recorded at a *different* screen size — replaying that
      // leaves blank lines at the top and the prompt in the middle of the pane.
      // Replay is for the cases where it's faithful: a live process (reload/HMR,
      // same buffer) and a manual "Resume" after suspend (no spawn until the click).
      const freshBoot = !attached.alive && autoStart;

      if (attached.data && !freshBoot) term.write(attached.data);

      if (attached.alive) {
        store.markRunning(id, attached.pid);
        void ipc.resizePty(id, term.rows, term.cols).catch(() => {});
      } else if (attached.exit) {
        store.markExited(id, attached.exit.code, attached.exit.reason);
        if (autoStart) void doStart({ keepScrollback: false });
      } else if (autoStart) {
        void doStart({ keepScrollback: false });
      }
    })();

    const onData = term.onData((data) => {
      void ipc.writePty(id, data).catch(() => {});
    });
    const onBinary = term.onBinary((data) => {
      void ipc
        .writePty(
          id,
          Array.from(data, (c) => String.fromCharCode(c.charCodeAt(0) & 255)).join(""),
        )
        .catch(() => {});
    });

    // Resize: one frame for layout to settle, ~50 ms debounce so we don't
    // hammer ConPTY (which aggressively repaints on every resize, §9.1).
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          void ipc.resizePty(id, term.rows, term.cols).catch(() => {});
        }, 50);
      });
    });
    ro.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      ro.disconnect();
      onData.dispose();
      onBinary.dispose();
      unlisteners.forEach((u) => u());
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
      void ipc.resizePty(id, term.rows, term.cols).catch(() => {});
    } catch {
      /* ignore */
    }
  }, [id, px, fontFamily, scrollback, cursorBlink]);

  // --- visibility: a hidden pane drops to 1 emission/450 ms (§5.3) ---
  useEffect(() => {
    void ipc.setPtyVisible(id, visible).catch(() => {});
    if (visible) {
      const t = setTimeout(() => {
        try {
          fitRef.current?.fit();
          const term = termRef.current;
          if (term) void ipc.resizePty(id, term.rows, term.cols).catch(() => {});
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
      style={style}
      onMouseDown={onFocus}
      onContextMenu={(e) => {
        // The host WebView2 would show "Inspecionar / Copiar imagem".
        // The card/pane above this opens the Yard menu instead.
        e.preventDefault();
      }}
    />
  );
});
