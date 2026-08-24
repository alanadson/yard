/**
 * Frame of a pane: tabs, title, state and actions.
 *
 * In normal use there is a single pane filling the screen and each CLI is a
 * tab on the top bar — creating a terminal never splits the screen (§F2).
 *
 * All terminals in the slot stay mounted; only the active one is visible.
 * That keeps `XTermView` (and therefore the attach) stable when switching
 * tabs, and the backend drops emission of the hidden ones to 450 ms.
 *
 * The action bar shows only three fixed buttons (find, start/suspend and the
 * kebab): with 4 or 6 panes open, a row of six icons per pane becomes
 * noise and eats the tabs.
 *
 * **A file is a tab here too.** Opening something from the tree adds it to
 * this same bar, right beside the CLI that is editing it, and it gets exactly
 * the pane's size — no window over the app. When the active tab is a
 * document the body is the editor and the terminal actions step aside
 * (nothing to suspend, nothing to search in the scrollback); the terminals
 * stay mounted and hidden behind it, so no agent notices.
 */
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Bot,
  ClipboardPaste,
  Eraser,
  Globe,
  Maximize2,
  NotebookPen,
  Play,
  PauseCircle,
  Pencil,
  Search,
  Terminal as TerminalIcon,
  Workflow,
  MessageSquarePlus,
  MoreVertical,
  Plus,
  X,
} from "lucide-react";

import { TerminalMark } from "../BrandIcon";
import { FileGlyph } from "../FileGlyph";
import { BrowserBody, browserLabel, browserMenuItems } from "../BrowserPane";
import { ExitBanner } from "../ExitBanner";
import type { XTermHandle } from "../XTermView";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { InlineRename } from "../ContextMenu/InlineRename";
import { closeDocTab, docTabMenu } from "../../lib/editorActions";
import { show } from "../../lib/navigate";
import { paneMenu } from "../../lib/paneMenu";
import { captureTextTarget, textMenuEntries } from "../../lib/textMenu";
import { terminalActionEntries } from "../../lib/terminalMenu";
import { beginTabDrag } from "../../lib/tabDrag";
import { flowsOf } from "../../lib/flow";
import { isConnected } from "../../lib/canvasOps";
import { ipc, type TerminalRow } from "../../lib/ipc";
import { confirmClearTerminal, confirmCloseTerminal } from "../../lib/lifecycle";
import { fileName } from "../../lib/paths";
import { baseName } from "../../lib/terminals";
import { useAction } from "../../hooks/useAction";
import { useBrowsers, type PaneBrowser } from "../../stores/browsersStore";
import { isDirty, isReadOnly, tabLabel, useEditor, type OpenDoc } from "../../stores/editorStore";
import { NOTES_TAB_ID, useNotes } from "../../stores/notesStore";
import { useAgents } from "../../stores/agentsStore";
import { useFlows } from "../../stores/flowStore";
import { useLive } from "../../stores/liveStore";
import { useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";

const XTermView = lazy(() => import("../XTermView"));
const EditorBody = lazy(() =>
  import("../CodeEditor").then((module) => ({ default: module.EditorBody })),
);
// Rides the same lazy wagon as the editor: CodeMirror only downloads when
// the notebook (or a file) actually shows up.
const NotesEmbed = lazy(() =>
  import("../NotesView").then((module) => ({ default: module.NotesEmbed })),
);

interface Props {
  groupId: string;
  slot: number;
  terminals: TerminalRow[];
  /** Files open in this pane — tabs in the same bar as the CLIs. */
  docs: OpenDoc[];
  /** Embedded browsers — tabs here too, same engine as a canvas portal. */
  browsers: PaneBrowser[];
  /** The notebook's tab is docked in this pane (`notesStore.place`). */
  notes: boolean;
  activeId: string | null;
  /**
   * First free pane of the group, or `null` when all six are taken. It is the
   * target of the "new pane" strip that appears while a tab is being dragged:
   * without it, splitting the screen meant first discovering Grid mode on the
   * title bar — in auto mode there was nowhere to drag to.
   */
  newSlot: number | null;
}

export function TerminalPane({
  groupId,
  slot,
  terminals,
  docs,
  browsers,
  notes,
  activeId,
  newSlot,
}: Props) {
  const setActiveTab = useProjects((s) => s.setActiveTab);
  const updateTerminal = useProjects((s) => s.updateTerminal);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);
  // Resource ticks replace runtime objects every two seconds. Only the active
  // tab paints memory; hidden tabs care about lifecycle/unread state alone.
  const runtimeSignals = useTerminals((s) =>
    terminals
      .map((t) => {
        const r = s.byId[t.id];
        const rss = t.id === activeId ? r?.rssMb ?? 0 : "";
        return `${t.id}:${r?.state ?? "idle"}:${r?.unread ? 1 : 0}:${r?.finished ? 1 : 0}:${r?.blocked ? 1 : 0}:${rss}`;
      })
      .join("|"),
  );
  const runtimes = useMemo(
    () => useTerminals.getState().byId,
    [runtimeSignals, terminals],
  );
  const act = useAction();
  /**
   * Roles live on the group's canvas even for a group that never opened it:
   * the card and the tab are two views of one terminal, so the chip has to
   * follow the CLI into the pane.
   */
  const roles = useProjects((s) => s.layoutOf(groupId).canvas?.roles) ?? {};

  /**
   * Flows armed on this pane's CLIs — wired, with the trigger on and with
   * stages. It is the information that was missing outside the canvas: Enter
   * in a wired CLI does not go to the agent, it goes to the pipeline, and the
   * only permanent sign of that lived on the board's card.
   *
   * The signature is a string on purpose: the canvas is rewritten on every
   * keystroke typed into a note, and a stable signature keeps that from
   * repainting the tab bar.
   */
  const flowSig = useProjects((s) => {
    const canvas = s.layoutOf(groupId).canvas;
    if (!canvas) return "";
    return flowsOf(canvas)
      .filter((f) => f.trigger !== false && f.stages.length > 0)
      .map((f) => `${f.id}:${f.name}:${f.stages.length}`)
      .join("|");
  });
  const armed = useMemo(() => {
    const out: Record<string, { name: string; etapas: number }> = {};
    const canvas = useProjects.getState().layoutOf(groupId).canvas;
    if (!canvas) return out;
    for (const f of flowsOf(canvas)) {
      if (f.trigger === false || f.stages.length === 0) continue;
      for (const t of terminals) {
        if (isConnected(canvas, f.id, t.id)) {
          out[t.id] = { name: f.name, etapas: f.stages.length };
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowSig, terminals, groupId]);
  /** Current stage of whatever is running right now, per terminal. */
  const flowMarks = useFlows((s) => s.marks);

  const handles = useRef<Record<string, XTermHandle | null>>({});
  const tabsRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** "3 of 12" — published by the xterm on every result change. */
  const [matches, setMatches] = useState<{ index: number; count: number } | null>(
    null,
  );
  const [overflow, setOverflow] = useState(false);
  /**
   * The tab's balloon, drawn here and not by the CSS: the tab strip scrolls,
   * and an `::after` inside it is clipped by the strip itself — which is why
   * the tab tooltips (command and folder) existed without ever showing.
   */
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    id: string;
    anchor: MenuAnchor;
  } | null>(null);
  /** Menu that arrives with its entries ready (the body of the open file). */
  const [readyMenu, setReadyMenu] = useState<{
    anchor: MenuAnchor;
    entries: MenuEntry[];
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  /**
   * The document on screen, when the selected tab is a file. It wins over the
   * terminal fallback: with a file selected there is no "first terminal" to
   * fall back to — that is the tab the user left behind.
   */
  const activeDoc = useMemo(
    () => docs.find((d) => d.id === activeId) ?? null,
    [docs, activeId],
  );
  /** The browser on screen, when the selected tab is one. */
  const activeBrowser = useMemo(
    () => browsers.find((b) => b.id === activeId) ?? null,
    [browsers, activeId],
  );
  /**
   * The notebook on screen. Besides being chosen, it also answers when the
   * saved active id resolves to nothing at all (a tab another store closed
   * without knowing about this one): showing the notebook beats an empty body.
   */
  const activeNotes =
    notes &&
    !activeDoc &&
    !activeBrowser &&
    (activeId === NOTES_TAB_ID || terminals.length === 0);
  const active = useMemo(
    () =>
      activeDoc || activeBrowser || activeNotes
        ? null
        : (terminals.find((t) => t.id === activeId) ?? terminals[0] ?? null),
    [terminals, activeId, activeDoc, activeBrowser, activeNotes],
  );
  const focused = !!active && active.id === focusedTerminalId;
  /**
   * Does this agent write its session to disk? That is what Live has to read.
   *
   * Sits **below** `active` on purpose: zustand calls the selector during
   * render, so reading it from further up would land in the `const` dead zone
   * and bring the whole pane down. See `lib/hookOrder.ts`.
   */
  const hasSession = useAgents((s) =>
    active?.agentId ? !!s.byId[active.agentId]?.sessionsKind : false,
  );

  // Marks as read when it gains focus. When focus arrives from the keyboard
  // (Ctrl+1..9, Ctrl+Tab) the cursor also needs to enter the tab's xterm —
  // without that typing would keep going to the previous tab.
  useEffect(() => {
    if (active && focusedTerminalId === active.id) {
      useTerminals.getState().markRead(active.id);
      handles.current[active.id]?.focus();
    }
  }, [active, focusedTerminalId]);

  // Ctrl+Shift+F arrives as a window event: only the pane that has focus
  // opens find (with 4 panes, opening all four would be absurd).
  useEffect(() => {
    if (!focused) return;
    const openIt = () => setSearchOpen(true);
    window.addEventListener("yard:find", openIt);
    return () => window.removeEventListener("yard:find", openIt);
  }, [focused]);

  /**
   * While the box is open, the xterm publishes here how many matches there
   * are and which one we are on; on closing, the highlights leave the screen.
   */
  useEffect(() => {
    const h = active ? handles.current[active.id] : null;
    if (!searchOpen || !h) {
      setMatches(null);
      return;
    }
    h.setSearchListener(setMatches);
    // Reopening the box with the previous term has to search again: without
    // this the count stayed blank (and reading it as "no results" would be a
    // lie, because nothing had been searched yet).
    if (query) h.findIncremental(query);
    return () => {
      h.setSearchListener(null);
      h.clearSearch();
    };
    // `query` left out on purpose: `onChange` already searches on every
    // keystroke, and re-running this effect per key would drop and re-attach
    // the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, active]);

  // Switching tabs with the search open resets the count: it is another scrollback.
  useEffect(() => setMatches(null), [active?.id]);

  // The tab bar scrolls with no visible scrollbar; without this measurement
  // nothing would warn that there are tabs off-screen.
  useLayoutEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // Every tab counts: only the CLIs triggered the measurement, and opening
    // four files left the "more tabs" fade lying until the next resize.
  }, [terminals.length, docs.length, browsers.length, notes]);

  /** Holds the balloon for half a second, like the CSS balloon in the rest of the app. */
  const showTip = (e: React.MouseEvent<HTMLElement>, text: string) => {
    const target = e.currentTarget;
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => {
      // Measured against the pane, which is what anchors the balloon — the
      // strip scrolls, and a position relative to it would drift as soon as
      // there was any scrolling (or the header's breathing room).
      const pane = target.closest(".pane")?.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      if (!pane) return;
      setTip({ x: r.left - pane.left + r.width / 2, text });
    }, 500);
  };
  const hideTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    setTip(null);
  };
  useEffect(() => () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
  }, []);

  /**
   * Arrow keys on the tab strip.
   *
   * The strip announces itself as a `tablist` with a single tab stop — without
   * this the keyboard only reached the active tab, and the pattern the markup
   * promises was not honored.
   */
  const onTabsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    // While renaming inside the tab, the arrows belong to the field — moving
    // focus from here would drag the text cursor along.
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const tabs = [
      ...(tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ];
    if (tabs.length === 0) return;
    e.preventDefault();
    const currentValue = tabs.indexOf(document.activeElement as HTMLElement);
    const i =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? tabs.length - 1
          : ((currentValue < 0 ? 0 : currentValue) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    const target = tabs[i];
    target.focus();
    // Automatic activation, like every tab bar in this app: the focused tab
    // is the tab you see.
    target.click();
  };

  const newCli = () => openModal("new-terminal", { groupId, slot });
  // Born blank on purpose: the URL bar autofocuses, which is what "new tab"
  // means in every browser — no modal in the way.
  const newBrowser = () => useBrowsers.getState().open({ groupId, slot });

  if (terminals.length === 0 && docs.length === 0 && browsers.length === 0 && !notes) {
    return (
      <div
        className="pane pane--empty"
        data-pane-group={groupId}
        data-pane-slot={slot}
        onContextMenu={(e) => {
          e.preventDefault();
          setTabMenu({ id: "", anchor: { x: e.clientX, y: e.clientY } });
        }}
      >
        <div className="pane-empty-inner">
          <TerminalIcon size={22} aria-hidden="true" />
          <span>Painel {slot + 1} vazio</span>
          <small>Arraste a aba de outro painel para cá, ou abra uma CLI nova.</small>
          <div className="pane-empty-actions">
            <button className="btn btn--sm" onClick={newCli}>
              <Plus size={12} /> Nova aba aqui
            </button>
            <button className="btn btn--sm" onClick={newBrowser}>
              <Globe size={12} /> Navegador aqui
            </button>
          </div>
        </div>
      </div>
    );
  }

  const rt = active ? (runtimes[active.id] ?? null) : null;
  const isRunning = isLive(rt);

  /** The pane's menu: what to open here, and the group's layout. */
  const buildPaneMenu = (): MenuEntry[] =>
    paneMenu(
      {
        mode: useProjects.getState().layoutOf(groupId).mode,
        surface: useProjects.getState().layoutOf(groupId).surface,
        notesHere: notes,
      },
      {
        newCli: newCli,
        newBrowser: newBrowser,
        dockNotes: () => useNotes.getState().dockTo(groupId, slot),
        setMode: (mode) => useProjects.getState().updateLayout(groupId, { mode }),
        showSurface: (surface) => show(groupId, surface),
      },
    );

  const tabMenuItems = (id: string): MenuEntry[] => {
    // `""` is the pane background — no tab claimed the click.
    if (id === "") return buildPaneMenu();
    // The notes tab's menu is the placement switch the notebook's own top
    // bar carries, reachable without activating the tab first.
    if (id === NOTES_TAB_ID) {
      return [
        {
          id: "overlay",
          label: "Sobrepor à tela",
          icon: <AppWindow size={13} />,
          onSelect: () => useNotes.getState().setPlaceKind("overlay"),
        },
        {
          id: "center",
          label: "Ocupar a área central",
          icon: <Maximize2 size={13} />,
          onSelect: () => useNotes.getState().setPlaceKind("center"),
        },
        { kind: "sep" },
        {
          id: "close",
          label: "Fechar aba",
          icon: <X size={13} />,
          danger: true,
          onSelect: () => useNotes.getState().closeDock(),
        },
      ];
    }
    // A file tab gets the editor's own menu — close the others, save, copy
    // the path — the same one the overlay editor shows.
    const theFile = docs.find((d) => d.id === id);
    if (theFile) return docTabMenu(theFile, docs);
    // A browser tab carries browser knobs — UA, cookies, rename, close —
    // the same set its canvas twin offers.
    const browser = browsers.find((b) => b.id === id);
    if (browser) {
      return [
        {
          id: "rename",
          label: "Renomear",
          icon: <Pencil size={13} />,
          onSelect: () => setRenamingId(id),
        },
        { kind: "sep" },
        ...browserMenuItems(browser, showToast),
        { kind: "sep" },
        {
          id: "close",
          label: "Fechar navegador",
          icon: <X size={13} />,
          danger: true,
          onSelect: () => useBrowsers.getState().close(id),
        },
      ];
    }
    const target = terminals.find((x) => x.id === id);
    if (!target) return [];
    const role = roles[id];
    return [
      {
        id: "rename",
        label: "Renomear",
        icon: <Pencil size={13} />,
        onSelect: () => setRenamingId(id),
      },
      // The same role a canvas card carries: a tab is the other face of the
      // same terminal, and a CLI opened here has to be configurable here.
      {
        id: "role",
        label: role ? `Papel: ${role.name}…` : "Definir papel…",
        icon: <Bot size={13} />,
        onSelect: () => openModal("role", { terminalId: id }),
      },
      {
        id: "paste",
        label: "Colar no terminal",
        icon: <ClipboardPaste size={13} />,
        shortcut: "Ctrl+V",
        disabled: !isLive(runtimes[id]),
        onSelect: () => handles.current[id]?.paste(),
      },
      {
        id: "clear",
        label: "Limpar terminal",
        icon: <Eraser size={13} />,
        danger: true,
        onSelect: () => {
          void confirmClearTerminal(id).then((ok) => {
            if (ok) handles.current[id]?.clear();
          });
        },
      },
      { kind: "sep" },
      ...terminalActionEntries({ id, running: isLive(runtimes[id]), run: act }),
    ];
  };

  return (
    <div
      className={`pane ${focused ? "pane--focused" : ""}`}
      data-pane-group={groupId}
      data-pane-slot={slot}
      // The pane's frame — the bar outside the tabs, the strip below them.
      // Tabs and bodies stop propagation with their own menus; what remains
      // is the pane, and the pane talks about what to open here.
      onContextMenu={(e) => {
        if (captureTextTarget(e.nativeEvent).info.editable) return;
        e.preventDefault();
        setTabMenu({ id: "", anchor: { x: e.clientX, y: e.clientY } });
      }}
    >
      <div className="pane-header">
        <div
          className="pane-tabs"
          ref={tabsRef}
          role="tablist"
          aria-label={`Abas do painel ${slot + 1}`}
          data-overflow={overflow}
          onKeyDown={onTabsKeyDown}
          onMouseLeave={hideTip}
        >
          {terminals.map((t) => {
            const r = runtimes[t.id];
            const label = baseName(t);
            const select = () => {
              setActiveTab(groupId, slot, t.id);
              focusTerminal(t.id, slot);
              handles.current[t.id]?.focus();
            };
            const openMenu = (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              setActiveTab(groupId, slot, t.id);
              focusTerminal(t.id, slot);
              setTabMenu({ id: t.id, anchor: { x: e.clientX, y: e.clientY } });
            };
            return (
              // The slot is a presentational wrapper: `role="tab"` stays on
              // the tab itself, and the close button is a sibling instead of
              // an interactive span nested inside it (which the keyboard
              // could not reach and the browser routed to the outer control).
              <div
                key={t.id}
                role="presentation"
                className={`pane-tab-slot ${t.id === active?.id ? "is-active" : ""}`}
                data-tab-kind="terminal"
                data-tab-id={t.id}
                onPointerDown={(e) => {
                  if (renamingId !== t.id) beginTabDrag(e, "terminal", t.id);
                }}
                onContextMenu={openMenu}
              >
                <button
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={t.id === active?.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={t.id === active?.id ? 0 : -1}
                  className="pane-tab"
                  onClick={select}
                  // Middle button closes the tab — same as every browser and
                  // every tabbed terminal.
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    void confirmCloseTerminal(t.id);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenamingId(t.id);
                  }}
                  onMouseEnter={(e) =>
                    showTip(e, `${t.program} ${t.args.join(" ")}\n${t.cwd}`)
                  }
                  onMouseLeave={hideTip}
                >
                  <span className={`dot dot--${r?.state ?? "idle"}`} />
                  <TerminalMark term={t} size={13} />
                  {renamingId === t.id ? (
                    <InlineRename
                      value={label}
                      onCommit={(next) => {
                        updateTerminal(t.id, { title: next });
                        setRenamingId(null);
                      }}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <span className="pane-tab-label">{label}</span>
                  )}
                  {roles[t.id] && (
                    <span className="pane-tab-role">{roles[t.id].name}</span>
                  )}
                  {/* Running now beats "armed": the current stage is the most
                      urgent information the tab can carry. */}
                  {flowMarks[t.id] ? (
                    <span
                      className={`pane-tab-flow is-${flowMarks[t.id].status}`}
                      data-tip-wrap=""
                      data-tip={`Fluxo "${flowMarks[t.id].name}" — etapa ${flowMarks[t.id].step}/${flowMarks[t.id].total}`}
                    >
                      <Workflow size={10} aria-hidden="true" />
                      {flowMarks[t.id].step}/{flowMarks[t.id].total}
                      <span className="sr-only">
                        — executando o fluxo {flowMarks[t.id].name}, etapa{" "}
                        {flowMarks[t.id].step} de {flowMarks[t.id].total}
                      </span>
                    </span>
                  ) : armed[t.id] ? (
                    <span
                      className="pane-tab-flow is-armed"
                      data-tip-wrap=""
                      data-tip={`O Enter desta CLI entra no fluxo "${armed[t.id].name}" (${armed[t.id].etapas} etapas). Desarme no cartão do fluxo, no canvas.`}
                    >
                      <Workflow size={10} aria-hidden="true" />
                      <span className="sr-only">
                        — o Enter desta CLI entra no fluxo {armed[t.id].name}
                      </span>
                    </span>
                  ) : null}
                  {/* The badges are empty circles; the sr-only text is what
                      carries the state into the tab's accessible name. */}
                  {r?.blocked ? (
                    <span
                      className="badge-blocked"
                      data-tip-wrap=""
                      data-tip={r.blockedAsk ?? "Esperando uma resposta sua"}
                    >
                      <span className="sr-only">— esperando uma resposta sua</span>
                    </span>
                  ) : r?.finished ? (
                    <span className="badge-finished" data-tip="Terminou de trabalhar">
                      <span className="sr-only">— terminou de trabalhar</span>
                    </span>
                  ) : r?.unread ? (
                    <span className="badge-unread" data-tip="Saída nova">
                      <span className="sr-only">— saída nova</span>
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="pane-tab-close"
                  aria-label={`Fechar ${label}`}
                  data-tip="Fechar"
                  onClick={() => void confirmCloseTerminal(t.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          {/* Files, after the CLIs and in the same bar: the tab where the
              agent works and the tab where the file is read sit side by side,
              which is the whole reason the editor stopped being a window. */}
          {docs.map((d) => {
            const dirty = isDirty(d) && !isReadOnly(d);
            return (
              <div
                key={d.id}
                role="presentation"
                className={`pane-tab-slot pane-tab-slot--doc ${
                  d.id === activeDoc?.id ? "is-active" : ""
                }`}
                data-tab-kind="doc"
                data-tab-id={d.id}
                onPointerDown={(e) => beginTabDrag(e, "doc", d.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  useEditor.getState().setActive(d.id);
                  setTabMenu({ id: d.id, anchor: { x: e.clientX, y: e.clientY } });
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id={`tab-${d.id}`}
                  aria-selected={d.id === activeDoc?.id}
                  aria-controls={`panel-${d.id}`}
                  tabIndex={d.id === activeDoc?.id ? 0 : -1}
                  className="pane-tab"
                  onMouseEnter={(e) => showTip(e, `${d.path}\n${d.root}`)}
                  onMouseLeave={hideTip}
                  onClick={() => useEditor.getState().setActive(d.id)}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    void closeDocTab(d.id);
                  }}
                >
                  <span className="pane-tab-file" aria-hidden="true">
                    <FileGlyph name={fileName(d.path)} size={13} />
                  </span>
                  <span className="pane-tab-label">{tabLabel(d, docs)}</span>
                  {(d.stale || d.missing) && (
                    <AlertTriangle size={12} className="pane-tab-warn" />
                  )}
                </button>
                <button
                  type="button"
                  className="pane-tab-close"
                  aria-label={
                    dirty ? `Fechar ${fileName(d.path)} (não salvo)` : `Fechar ${fileName(d.path)}`
                  }
                  data-tip={dirty ? "Fechar (não salvo)" : "Fechar"}
                  onClick={() => void closeDocTab(d.id)}
                >
                  {dirty ? <span className="editor-dot" aria-hidden="true" /> : <X size={12} />}
                </button>
              </div>
            );
          })}

          {/* Browsers, last: a page open beside the CLI that is editing it,
              with the whole pane's size — the same reason files became tabs. */}
          {browsers.map((b) => {
            const label = browserLabel(b);
            const select = () => {
              setActiveTab(groupId, slot, b.id);
              // A browser in focus is no terminal in focus — keys must not
              // keep going to a CLI the user can no longer see.
              focusTerminal(null, slot);
            };
            const openContextMenu = (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              select();
              setTabMenu({ id: b.id, anchor: { x: e.clientX, y: e.clientY } });
            };
            return (
              <div
                key={b.id}
                role="presentation"
                className={`pane-tab-slot pane-tab-slot--browser ${
                  b.id === activeBrowser?.id ? "is-active" : ""
                }`}
                data-tab-kind="browser"
                data-tab-id={b.id}
                onPointerDown={(e) => {
                  if (renamingId !== b.id) beginTabDrag(e, "browser", b.id);
                }}
                onContextMenu={openContextMenu}
              >
                <button
                  type="button"
                  role="tab"
                  id={`tab-${b.id}`}
                  aria-selected={b.id === activeBrowser?.id}
                  aria-controls={`panel-${b.id}`}
                  tabIndex={b.id === activeBrowser?.id ? 0 : -1}
                  className="pane-tab"
                  onMouseEnter={(e) => showTip(e, b.url)}
                  onMouseLeave={hideTip}
                  onClick={select}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    useBrowsers.getState().close(b.id);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenamingId(b.id);
                  }}
                >
                  <Globe size={13} className="pane-tab-file" aria-hidden="true" />
                  {renamingId === b.id ? (
                    <InlineRename
                      value={label}
                      onCommit={(next) => {
                        useBrowsers.getState().patch(b.id, { name: next });
                        setRenamingId(null);
                      }}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <span className="pane-tab-label">{label}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="pane-tab-close"
                  aria-label={`Fechar ${label}`}
                  data-tip="Fechar"
                  onClick={() => useBrowsers.getState().close(b.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          {/* The notebook, last: one global tab (there is a single notebook),
              docked beside the CLIs for the same reason files and pages are. */}
          {notes && (
            <div
              role="presentation"
              className={`pane-tab-slot pane-tab-slot--notes ${activeNotes ? "is-active" : ""}`}
              data-tab-kind="notes"
              data-tab-id={NOTES_TAB_ID}
              onPointerDown={(e) => beginTabDrag(e, "notes", NOTES_TAB_ID)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTabMenu({ id: NOTES_TAB_ID, anchor: { x: e.clientX, y: e.clientY } });
              }}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${NOTES_TAB_ID}`}
                aria-selected={activeNotes}
                aria-controls={`panel-${NOTES_TAB_ID}`}
                tabIndex={activeNotes ? 0 : -1}
                className="pane-tab"
                onMouseEnter={(e) =>
                  showTip(e, "Anotações — o caderno de notas markdown")
                }
                onMouseLeave={hideTip}
                onClick={() => {
                  setActiveTab(groupId, slot, NOTES_TAB_ID);
                  // The notebook in focus is no terminal in focus — same
                  // rule as a document or a browser tab.
                  focusTerminal(null, slot);
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  useNotes.getState().closeDock();
                }}
              >
                <NotebookPen size={13} className="pane-tab-file" aria-hidden="true" />
                <span className="pane-tab-label">Anotações</span>
              </button>
              <button
                type="button"
                className="pane-tab-close"
                aria-label="Fechar a aba de anotações"
                data-tip="Fechar"
                onClick={() => useNotes.getState().closeDock()}
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>

        {/* The balloon lives outside the scrolling strip — the only way for
            it to show (see the comment at `.pane-tabs [data-tip]::after`). */}
        {tip && (
          <div className="pane-tabtip" style={{ left: tip.x }} role="presentation">
            {tip.text}
          </div>
        )}

        {/* Glued to the last tab, the way every browser puts it. It used to sit
            at the far right of the bar (`.pane-tabs` grew to fill the pane), a
            hand's travel away from the tabs it belongs to and easy to read as
            one more of the pane's tools. The spacer below is what now pushes
            those tools to the edge.

            One button, straight into the "Nova aba" dialog — CLI, browser and
            whatever else a tab learns to be all live in the same quick-start
            grid, so the `+` needs no menu of its own. */}
        <button
          className="pane-tab-add"
          data-tip="Nova aba — CLI, navegador ou anotações (Ctrl+T)"
          aria-label="Nova aba nesta barra"
          onClick={newCli}
        >
          <Plus size={14} />
        </button>

        <div className="pane-gap" />

        {/* With a file, a browser or the notebook on screen the terminal
            actions have nothing to act on — each of those carries its own
            bars. Only the "new" buttons above stay, because opening a
            terminal from any tab is a reasonable thing to want.
            Taken out of the tree and not merely `hidden`: `.pane-actions` is
            a flex row, and an author `display` beats the attribute. */}
        {!activeDoc && !activeBrowser && !activeNotes && (
        <div className="pane-actions">
          {rt && rt.rssMb > 0 && (
            <span className="pane-stat" data-tip="RAM da árvore de processos">
              {rt.rssMb.toFixed(0)} MB
            </span>
          )}
          {/* Only three of the nine CLIs in the catalog write a session to
              disk; on the others Live opened and waited forever for a file
              that would never exist. The backend already answers who writes. */}
          {active?.kind === "agent" && hasSession && (
            <button
              className="icon-btn live-launch"
              data-tip-wrap=""
              data-tip="Ao Vivo — arquivos, plano e sub-agents em tempo real"
              aria-label="Abrir o Ao Vivo deste agente"
              data-working={isRunning || undefined}
              onClick={() => active && void useLive.getState().openFor(active)}
            >
              <Activity size={13} />
            </button>
          )}
          {/* The composer used to have a button only on the canvas card, so
              outside the canvas it was a keyboard secret. It is the same
              terminal either way — the way in has to be too. */}
          <button
            className="icon-btn"
            data-tip="Compositor de prompts (Ctrl+Enter)"
            aria-label="Abrir o compositor de prompts para este terminal"
            onClick={() => {
              if (!active) return;
              focusTerminal(active.id, slot);
              useUI.getState().setComposerOpen(true);
            }}
          >
            <MessageSquarePlus size={13} />
          </button>
          <button
            className={`icon-btn ${searchOpen ? "is-active" : ""}`}
            data-tip="Buscar no histórico (Ctrl+Shift+F)"
            aria-label="Buscar no histórico"
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search size={13} />
          </button>
          {isRunning ? (
            <button
              className="icon-btn"
              data-tip-wrap="" data-tip="Suspender — encerra o processo e guarda o histórico"
              aria-label="Suspender"
              onClick={() =>
                active && act(() => ipc.suspendPty(active.id), "falha ao suspender")
              }
            >
              <PauseCircle size={13} />
            </button>
          ) : (
            <button
              className="icon-btn icon-btn--go"
              data-tip="Iniciar ou retomar"
              aria-label="Iniciar ou retomar"
              onClick={() => active && handles.current[active.id]?.start()}
            >
              <Play size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            data-tip-at="right" data-tip="Mais ações"
            aria-label="Mais ações deste terminal"
            aria-haspopup="menu"
            onClick={(e) => {
              if (!active) return;
              const r = e.currentTarget.getBoundingClientRect();
              setTabMenu({
                id: active.id,
                anchor: { x: r.right - 200, y: r.bottom + 4 },
              });
            }}
          >
            <MoreVertical size={13} />
          </button>
        </div>
        )}
      </div>

      {searchOpen && (
        <div className="pane-search">
          <input
            autoFocus
            value={query}
            aria-label="Buscar no histórico do terminal"
            placeholder="Buscar no histórico…"
            aria-describedby={`pane-search-count-${slot}`}
            // Search on every keystroke: the count beside it is only worth
            // having if it keeps up with the typing.
            onChange={(e) => {
              setQuery(e.target.value);
              if (active) handles.current[active.id]?.findIncremental(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && active) {
                if (e.shiftKey) handles.current[active.id]?.findPrevious(query);
                else handles.current[active.id]?.findNext(query);
              }
              if (e.key === "Escape") {
                setSearchOpen(false);
                if (active) handles.current[active.id]?.focus();
              }
            }}
          />
          {/* The answer that was missing: without it, an Enter on a search
              with no match was indistinguishable from a broken button. */}
          <span
            className={`pane-search-count ${
              query && matches?.count === 0 ? "is-empty" : ""
            }`}
            id={`pane-search-count-${slot}`}
            role="status"
            aria-live="polite"
          >
            {!query
              ? ""
              : !matches || matches.count === 0
                ? "sem resultados"
                : matches.count < 0
                  ? "muitos resultados"
                  : `${Math.max(0, matches.index) + 1}/${matches.count}`}
          </span>
          <span className="pane-search-hint">Enter ↓ · Shift+Enter ↑</span>
          <button
            className="icon-btn"
            aria-label="Fechar busca"
            data-tip="Fechar busca (Esc)"
            onClick={() => setSearchOpen(false)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="pane-body">
        {terminals.map((t) => {
          const visible = t.id === active?.id;
          const r = runtimes[t.id];
          return (
            <div
              key={t.id}
              className="pane-term"
              id={`panel-${t.id}`}
              role="tabpanel"
              aria-labelledby={`tab-${t.id}`}
              // Hidden tabs stay mounted (that is what keeps the attach
              // stable), so the inactive panels have to be hidden from
              // assistive tech explicitly — `visibility: hidden` does that for
              // the eye but `aria-hidden` is what does it for a screen reader.
              aria-hidden={!visible}
              // `visibility` (and not `display: none`): the host keeps its
              // real size even when hidden, so the back-tab xterm can
              // measure font/cell and fit works. With display none the
              // renderer opens in a 0x0 host and explodes from the inside
              // ("reading 'dimensions'") on the first write.
              style={{ visibility: visible ? "visible" : "hidden" }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setActiveTab(groupId, slot, t.id);
                focusTerminal(t.id, slot);
                setTabMenu({ id: t.id, anchor: { x: e.clientX, y: e.clientY } });
              }}
            >
              <ExitBanner
                rt={r}
                term={t}
                onStart={(extra) =>
                  void handles.current[t.id]?.start(
                    extra ? { args: [...t.args, ...extra] } : undefined,
                  )
                }
              />
              <Suspense fallback={<div className="xterm-host" aria-hidden />}>
                <XTermView
                  ref={(h) => {
                    handles.current[t.id] = h;
                  }}
                  id={t.id}
                  program={t.program}
                  args={t.args}
                  cwd={t.cwd}
                  kind={t.kind}
                  title={t.title || t.program}
                  autoStart={t.alive}
                  visible={visible}
                  onFocus={() => focusTerminal(t.id, slot)}
                  // Over the terminal itself the right click never becomes a
                  // React event (it is stopped before xterm can act on it), so
                  // the panel's own handler above only covers the frame.
                  onContextMenu={(e) => {
                    setActiveTab(groupId, slot, t.id);
                    focusTerminal(t.id, slot);
                    setTabMenu({ id: t.id, anchor: { x: e.clientX, y: e.clientY } });
                  }}
                />
              </Suspense>
            </div>
          );
        })}

        {/* The editor covers the terminals instead of unmounting them: an
            agent must not notice that someone opened a file, and the xterm
            that comes back has to come back attached, not reborn. Only the
            active document is mounted — the buffers live in the store, so
            switching file tabs loses nothing. */}
        {activeDoc && (
          <div
            className="pane-doc"
            id={`panel-${activeDoc.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${activeDoc.id}`}
            // Text first (it is a writing surface), then the file — the same
            // menu the overlay editor shows.
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const theText = textMenuEntries(captureTextTarget(e.nativeEvent), {
                app: false,
              });
              const ofFile = docTabMenu(activeDoc, docs);
              setReadyMenu({
                anchor: { x: e.clientX, y: e.clientY },
                entries:
                  theText.length > 0 ? [...theText, { kind: "sep" }, ...ofFile] : ofFile,
              });
            }}
          >
            <Suspense fallback={<div className="editor-surface" aria-hidden />}>
              <EditorBody docId={activeDoc.id} />
            </Suspense>
          </div>
        )}

        {/* Only the active browser is mounted: unmounting merely hides the
            native page (its scroll, session and history live in the backend
            registry), so switching tabs loses nothing — see BrowserPane. */}
        {activeBrowser && (
          <div
            className="pane-doc pane-browser-host"
            id={`panel-${activeBrowser.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${activeBrowser.id}`}
          >
            <BrowserBody tab={activeBrowser} />
          </div>
        )}

        {/* The notebook mounts only while its tab is active — which is also
            what keeps a single note surface alive at a time (its CodeMirror
            compartments are module singletons). The text lives in the store,
            so switching away loses nothing. */}
        {activeNotes && (
          <div
            className="pane-doc"
            id={`panel-${NOTES_TAB_ID}`}
            role="tabpanel"
            aria-labelledby={`tab-${NOTES_TAB_ID}`}
          >
            <Suspense fallback={<div className="editor-surface" aria-hidden />}>
              <NotesEmbed />
            </Suspense>
          </div>
        )}
      </div>

      {/* Only exists while a tab is being dragged (`body.is-tab-drag`):
          dropping here sends the tab to the first free pane, and in auto mode
          the grid grows on its own to show it. `data-pane-slot` is what
          `tabDrag` reads — the strip is a drop target like any pane. */}
      {newSlot !== null && (
        <div
          className="pane-dropnew"
          data-pane-group={groupId}
          data-pane-slot={newSlot}
        >
          <span>Novo painel</span>
        </div>
      )}

      {readyMenu && (
        <ContextMenu
          anchor={readyMenu.anchor}
          items={readyMenu.entries}
          onClose={() => setReadyMenu(null)}
        />
      )}
      {tabMenu && (
        <ContextMenu
          anchor={tabMenu.anchor}
          items={tabMenuItems(tabMenu.id)}
          onClose={() => setTabMenu(null)}
        />
      )}

    </div>
  );
}
