/**
 * A loose terminal on the canvas: a draggable, resizable frame around
 * the same `XTermView` as the tabs — attach-before-spawn (§4.3) is what
 * makes switching grid <-> canvas cost the process nothing.
 *
 * Drag and resize work in world coordinates: the screen delta is
 * divided by zoom before becoming a position. Zoom does not resize the PTY —
 * only resizing the card itself changes rows/columns.
 *
 * Memoized: with several cards on the canvas, dragging one should only
 * re-render that one — the rest shouldn't even know something moved.
 */
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Bot,
  BringToFront,
  ClipboardCopy,
  ClipboardPaste,
  Clock,
  Eraser,
  FileText,
  FolderOpen,
  Globe,
  ListPlus,
  Maximize,
  Maximize2,
  MessageSquarePlus,
  Minimize,
  MoreVertical,
  PauseCircle,
  Pin,
  PinOff,
  Play,
  SendToBack,
  Type,
  Workflow,
} from "lucide-react";

import { TerminalMark } from "../BrandIcon";
import { ExitBanner } from "../ExitBanner";
import type { XTermHandle } from "../XTermView";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { InlineRename } from "../ContextMenu/InlineRename";
import { ResizeHandles } from "./ResizeHandles";
import { ipc, type TerminalRow } from "../../lib/ipc";
import { copyText } from "../../lib/clipboard";
import { hasDragPaths, readDragPaths, shellQuote } from "../../lib/canvasDrop";
import { isConnected } from "../../lib/canvasOps";
import { flowsOf } from "../../lib/flow";
import { confirmClearTerminal } from "../../lib/lifecycle";
import { spawnPortalNear } from "../../lib/portalSpawn";
import { terminalActionEntries } from "../../lib/terminalMenu";
import { baseName } from "../../lib/terminals";
import { useAction } from "../../hooks/useAction";
import { useAdvertised } from "../../stores/advertisedStore";
import { useAgents } from "../../stores/agentsStore";
import { useFlows, type FlowStageStatus } from "../../stores/flowStore";
import { useQueue } from "../../stores/queueStore";
import { openTranscriptFor } from "../../lib/transcriptOpen";
import { useLive } from "../../stores/liveStore";
import { useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import {
  CANVAS_COLORS,
  clamp,
  NODE_FONT_MAX,
  NODE_FONT_MIN,
  NODE_FONT_STEP,
  NODE_MIN_H,
  NODE_MIN_W,
  resizeRect,
  type CanvasNode,
  type CardRole,
  type RectPhase,
  type ResizeDir,
} from "../../lib/canvas";
import { useT } from "../../hooks/useT";
import { hudKind, hudLabel } from "./hud";

const XTermView = lazy(() => import("../XTermView"));

export type { RectPhase };

interface Props {
  term: TerminalRow;
  rect: CanvasNode;
  /**
   * Current zoom, read at gesture time. It's an accessor (not a number) on
   * purpose: as a prop, every zoom tick would re-render every
   * card — even though the world's transform already scales them on its own.
   */
  getZoom: () => number;
  focused: boolean;
  /** In the canvas selection — arranged, nudged and framed with the rest. */
  selected: boolean;
  /**
   * Announces the press that is about to start a drag, before the card
   * commits to one. It returns `false` when the click was about the selection
   * and not about moving (a Shift+click that toggled membership), which is the
   * only way the card can know it should stay put.
   */
  onPick: (id: string, e: React.PointerEvent) => boolean;
  /** Role assigned to the agent, visible on the chip and in `yard list`. */
  role?: CardRole;
  /** How many active routines point at this terminal (header badge). */
  routineCount: number;
  /** How many active triggers fire on this terminal (menu label count). */
  triggerCount: number;
  /** Role during the connect tool (frame highlight). */
  connectRole: "source" | "target" | null;
  onRect: (id: string, rect: CanvasNode, phase: RectPhase) => void;
  /** Card customization color; `undefined` reverts to the default. */
  onColor: (id: string, color?: string) => void;
  /** Font size of this card's terminal; `undefined` goes back to the prefs. */
  onFontSize: (id: string, px?: number) => void;
  onFocusZoom: (id: string) => void;
  registerHandle: (id: string, h: XTermHandle | null) => void;
  onMenuOpen?: (open: boolean) => void;
  /** Paint order among cards ("Trazer para a frente" / "Enviar para trás"). */
  onOrder: (id: string, dir: "front" | "back") => void;
  /** Fixes the card in place, or frees it. */
  onPin: (id: string, pinned: boolean) => void;
  /** Fills the visible board, or goes back to the rectangle it had. */
  onMaximize: (id: string) => void;
  /** The in-place rename is open on this card (the board owns which one). */
  renaming: boolean;
  onRenameStart: (id: string) => void;
  onRenameEnd: () => void;
  /**
   * Inside the viewport (plus a screen of margin), per `lib/culling.ts`. Off
   * screen the terminal keeps its process and coalesces its output slowly
   * instead of repainting for nobody.
   */
  visible: boolean;
  /**
   * How much bigger than its font the terminal draws, past 100% zoom
   * (`lib/renderScale.ts`); 1 leaves everything exactly as it was.
   */
  renderScale: number;
  /**
   * The front this card runs in, when that is worth a badge
   * (`lib/floorColor.ts`): always on a board, and on a project canvas only
   * for a card that lives in another front than the group's.
   */
  front?: { id: string; name: string; color: string };
  /** The lens: `on` = this front is highlighted, `off` = another one is. */
  frontFocus: "on" | "off" | null;
  onFocusFront: (id: string | null) => void;
}

/**
 * Column count "Encaixar fonte" aims for. Around a hundred is where most CLIs
 * were laid out to live: wide enough for a table, narrow enough that a
 * paragraph does not run away from the eye.
 */
const FIT_COLS = 100;

type DragKind = "move" | ResizeDir;

interface DragSession {
  kind: DragKind;
  pointerId: number;
  cx: number;
  cy: number;
  start: CanvasNode;
}

/** How each run status reads on the card's tooltip. */
const FLOW_STATUS_LABEL: Record<FlowStageStatus, string> = {
  // i18n-scan: tables — wrapped with t() where the badge renders it.
  pending: "aguardando a vez",
  waiting: "preparando a etapa",
  working: "trabalhando agora",
  blocked: "travado numa pergunta — responda na CLI",
  done: "etapa concluída",
  error: "a etapa falhou",
};


function TerminalCardImpl({
  term,
  rect,
  getZoom,
  focused,
  selected,
  onPick,
  role,
  routineCount,
  triggerCount,
  connectRole,
  onRect,
  onColor,
  onFontSize,
  onFocusZoom,
  registerHandle,
  onMenuOpen,
  onOrder,
  onPin,
  onMaximize,
  renaming,
  onRenameStart,
  onRenameEnd,
  visible,
  renderScale,
  front,
  frontFocus,
  onFocusFront,
}: Props) {
  const t = useT();
  const rt = useTerminals((s) => s.byId[term.id]);
  // The card's place in a *running* flow. Subscribed straight from the store
  // (not threaded through CanvasView): a run advancing should repaint the two
  // cards it touched, not the board.
  const flowMark = useFlows((s) => s.marks[term.id]);
  const queued = useQueue((s) => s.items.filter((i) => i.terminalId === term.id).length);
  const updateTerminal = useProjects((s) => s.updateTerminal);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const openModal = useUI((s) => s.openModal);
  const act = useAction();
  const setComposerOpen = useUI((s) => s.setComposerOpen);
  // Subscribed as a scalar: the whole `prefs` object would re-render every
  // card whenever any unrelated preference moved.
  const prefsFontSize = useUI((s) => s.prefs.fontSize);
  /** What this card actually paints with — its own size, or the global one. */
  const fontPx = rect.fontSize ?? prefsFontSize;

  const sess = useRef<DragSession | null>(null);
  const handleRef = useRef<XTermHandle | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [portalMenu, setPortalMenu] = useState<MenuAnchor | null>(null);

  /**
   * Addresses announced in this group — a dev server one click from a portal.
   *
   * The whole group, not this terminal alone: the CLI that ran the server is
   * usually not the one you are looking at, and "no button here, button
   * there" reads as a bug when both are working on the same site.
   */
  const served = useAdvertised((s) => s.byGroup[term.groupId]);
  /**
   * Only CLIs that write their session to disk have anything to show in Ao
   * Vivo — on the others the screen waited forever for the "first turn".
   */
  const hasSession = useAgents((s) =>
    term.agentId ? !!s.byId[term.agentId]?.sessionsKind : false,
  );

  const openPortal = useCallback(
    (url: string) => {
      void spawnPortalNear({
        groupId: term.groupId,
        url,
        nearTerminalId: term.id,
      }).catch((e) =>
        useUI.getState().showToast(t("Não consegui abrir o portal: {e}", { e: String(e) }), "error"),
      );
    },
    [term.groupId, term.id],
  );

  // The registration must survive unmount so the parent's map doesn't
  // accumulate dead handles.
  useEffect(() => () => registerHandle(term.id, null), [term.id, registerHandle]);

  /**
   * "A card menu is open" is owned by the menu's lifetime.
   *
   * Raising it by hand at the two call sites and lowering it in `onClose`
   * leaked whenever the card disappeared with the menu still up (the terminal
   * closed from the CLI, a group switch): the canvas kept the invisible sheet
   * that hides the portals and swallows clicks.
   */
  const menuOpen = menu !== null || portalMenu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    onMenuOpen?.(true);
    return () => onMenuOpen?.(false);
  }, [menuOpen, onMenuOpen]);

  // Stable: an inline ref would be a new function every render, and React
  // would unregister/re-register the handle on every drag frame.
  const setXtermRef = useCallback(
    (h: XTermHandle | null) => {
      handleRef.current = h;
      registerHandle(term.id, h);
    },
    [term.id, registerHandle],
  );

  const label = baseName(term);
  const running = isLive(rt);

  const startSession = (e: React.PointerEvent, kind: DragKind) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    e.preventDefault();
    e.stopPropagation();
    // The canvas owns the selection, so it gets the press first — and can veto
    // the drag when the click was only meant to add this card to a group.
    if (!onPick(term.id, e)) return;
    focusTerminal(term.id, term.slot);
    // Pinned: the press selects and focuses, and that is all it does.
    if (rect.pinned) return;
    sess.current = {
      kind,
      pointerId: e.pointerId,
      cx: e.clientX,
      cy: e.clientY,
      start: rect,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  /** The session's rectangle for the current pointer position. */
  const rectFor = (s: DragSession, e: React.PointerEvent): CanvasNode => {
    const zoom = getZoom();
    const dx = (e.clientX - s.cx) / zoom;
    const dy = (e.clientY - s.cy) / zoom;
    if (s.kind === "move") {
      return { ...s.start, x: s.start.x + dx, y: s.start.y + dy };
    }
    const box = resizeRect(s.start, s.kind, dx, dy, NODE_MIN_W, NODE_MIN_H);
    return { ...s.start, ...box };
  };

  const moveSession = (e: React.PointerEvent) => {
    const s = sess.current;
    if (!s || e.pointerId !== s.pointerId) return;
    onRect(term.id, rectFor(s, e), "live");
  };

  const endSession = (e: React.PointerEvent) => {
    const s = sess.current;
    if (!s || e.pointerId !== s.pointerId) return;
    sess.current = null;
    const r = rectFor(s, e);
    // A stationary click on the header doesn't become a commit: it would
    // waste a useless undo entry and a workspace rewrite.
    const changed =
      Math.abs(r.x - s.start.x) > 0.01 ||
      Math.abs(r.y - s.start.y) > 0.01 ||
      Math.abs(r.w - s.start.w) > 0.01 ||
      Math.abs(r.h - s.start.h) > 0.01;
    onRect(term.id, r, changed ? "commit" : "cancel");
  };

  // A function, not an array: this is ~14 entries with JSX icons, and as a
  // plain array it was rebuilt on every render of a card whose menu is shut —
  // which includes every frame of a drag.
  const menuItems = (): MenuEntry[] => [
    {
      kind: "swatches",
      colors: CANVAS_COLORS,
      active: rect.color,
      // Re-clicking the active color reverts to the card's default look.
      onPick: (c) => onColor(term.id, c === rect.color ? undefined : c),
    },
    {
      kind: "stepper",
      label: t("Tamanho da fonte"),
      value: `${fontPx}px`,
      // Dimmed while it is still the preference's number and not this card's.
      muted: rect.fontSize == null,
      onStep: (d) =>
        onFontSize(
          term.id,
          clamp(fontPx + d * NODE_FONT_STEP, NODE_FONT_MIN, NODE_FONT_MAX),
        ),
      onReset: rect.fontSize == null ? undefined : () => onFontSize(term.id, undefined),
    },
    {
      id: "fitfont",
      label: t("Encaixar fonte (~{n} colunas)", { n: FIT_COLS }),
      icon: <Type size={13} />,
      onSelect: () => {
        // Glyph width scales linearly with font size, so the size that lands
        // on FIT_COLS is just a proportion of what the card shows right now.
        // This is the answer to "the card got bigger and the text didn't".
        const cols = handleRef.current?.cols() ?? 0;
        if (!cols) return;
        onFontSize(
          term.id,
          clamp(
            Math.round((fontPx * cols) / FIT_COLS),
            NODE_FONT_MIN,
            NODE_FONT_MAX,
          ),
        );
      },
    },
    { kind: "sep" },
    ...(term.kind === "agent" && hasSession
      ? ([
          {
            id: "live",
            label: t("Ao Vivo — acompanhar o agente"),
            icon: <Activity size={13} />,
            onSelect: () => void useLive.getState().openFor(term),
          },
          {
            id: "transcript",
            label: t("Transcrição da sessão…"),
            icon: <FileText size={13} />,
            onSelect: () => void openTranscriptFor(term),
          },
        ] satisfies MenuEntry[])
      : []),
    {
      id: "role",
      label: role ? t("Papel: {name}…", { name: role.name }) : t("Definir papel…"),
      icon: <Bot size={13} />,
      onSelect: () => openModal("role", { terminalId: term.id }),
    },
    {
      id: "routines",
      label:
        routineCount + triggerCount > 0
          ? t("Rotinas e gatilhos… ({n})", { n: routineCount + triggerCount })
          : t("Rotinas e gatilhos…"),
      icon: <Clock size={13} />,
      onSelect: () =>
        openModal("routines", { groupId: term.groupId, terminalId: term.id }),
    },
    // Flows this CLI is wired to — this terminal is their trigger/executor.
    // Read lazily: menuItems only runs with the menu open, so the layout
    // parse never lands on a drag frame.
    ...(term.kind === "agent"
      ? (() => {
          const canvas = useProjects.getState().layoutOf(term.groupId).canvas;
          if (!canvas) return [] as MenuEntry[];
          return flowsOf(canvas)
            .filter((f) => isConnected(canvas, f.id, term.id))
            .map<MenuEntry>((f) => ({
              id: `flow-${f.id}`,
              label: t('Fluxo "{name}"…', { name: f.name }),
              icon: <Workflow size={13} />,
              onSelect: () =>
                openModal("flow", { groupId: term.groupId, itemId: f.id }),
            }));
        })()
      : []),
    {
      id: "center",
      label: t("Centralizar em 100%"),
      icon: <Maximize2 size={13} />,
      onSelect: () => onFocusZoom(term.id),
    },
    {
      id: "max",
      label: rect.restore ? t("Restaurar o tamanho") : t("Maximizar no canvas"),
      icon: rect.restore ? <Minimize size={13} /> : <Maximize size={13} />,
      onSelect: () => onMaximize(term.id),
    },
    {
      id: "pin",
      label: rect.pinned ? t("Soltar (voltar a mover)") : t("Fixar no lugar"),
      icon: rect.pinned ? <PinOff size={13} /> : <Pin size={13} />,
      onSelect: () => onPin(term.id, !rect.pinned),
    },
    {
      id: "front",
      label: t("Trazer para a frente"),
      icon: <BringToFront size={13} />,
      onSelect: () => onOrder(term.id, "front"),
    },
    {
      id: "back",
      label: t("Enviar para trás"),
      icon: <SendToBack size={13} />,
      onSelect: () => onOrder(term.id, "back"),
    },
    { kind: "sep" },
    {
      id: "copycwd",
      label: t("Copiar a pasta de trabalho"),
      icon: <ClipboardCopy size={13} />,
      onSelect: () => void copyText(term.cwd),
    },
    {
      id: "reveal",
      label: t("Mostrar na pasta"),
      icon: <FolderOpen size={13} />,
      onSelect: () =>
        void ipc
          .revealPath(term.cwd)
          .catch((e) => useUI.getState().showToast(String(e), "error")),
    },
    { kind: "sep" },
    {
      id: "paste",
      label: t("Colar no terminal"),
      icon: <ClipboardPaste size={13} />,
      shortcut: "Ctrl+V",
      disabled: !running,
      onSelect: () => handleRef.current?.paste(),
    },
    {
      id: "clear",
      label: t("Limpar terminal"),
      icon: <Eraser size={13} />,
      danger: true,
      onSelect: () => {
        void confirmClearTerminal(term.id).then((ok) => {
          if (ok) handleRef.current?.clear();
        });
      },
    },
    { kind: "sep" },
    ...terminalActionEntries({
      id: term.id,
      running,
      run: act,
      onRename: () => onRenameStart(term.id),
    }),
  ];


  return (
    <div
      className={`cv-card ${focused ? "is-focused" : ""} ${
        selected ? "is-selected" : ""
      } ${connectRole ? `is-connect-${connectRole}` : ""} ${
        flowMark ? `is-flow-${flowMark.status}` : ""
      } ${rect.pinned ? "is-pinned" : ""} ${rect.restore ? "is-max" : ""} ${
        // The rim says from across the board what the badge says up close.
        rt?.blocked ? (rt.permission ? "is-blocked is-permission" : "is-blocked") : rt?.finished ? "is-finished" : ""
      } ${frontFocus === "off" ? "is-dim" : frontFocus === "on" ? "is-front-focus" : ""}`}
      data-id={term.id}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      // A file dragged from the tree and dropped on the terminal is its path,
      // typed at the prompt, quoted when it has to be. The board's own drop
      // (a card) must not fire as well, hence the stop.
      onDragOver={(e) => {
        if (!hasDragPaths(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        const entries = readDragPaths(e.dataTransfer);
        if (entries.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        handleRef.current?.typeText(`${entries.map((p) => shellQuote(p.path)).join(" ")} `);
      }}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        // Inline would override the classes' focus/connect highlight; the
        // custom color only paints the frame when no highlight is active. A
        // card's own colour wins over its front's.
        ...(rect.color && !focused && !connectRole
          ? { borderColor: `color-mix(in srgb, ${rect.color} 45%, var(--border))` }
          : front && !focused && !connectRole
            ? { borderColor: `color-mix(in srgb, ${front.color} 55%, var(--border))` }
            : {}),
        ...(frontFocus === "on" ? ({ "--cv-front": front?.color } as React.CSSProperties) : {}),
      }}
    >
      <div
        className="cv-card-head"
        style={
          rect.color
            ? { background: `color-mix(in srgb, ${rect.color} 26%, var(--bg-raised))` }
            : undefined
        }
        onPointerDown={(e) => startSession(e, "move")}
        onPointerMove={moveSession}
        onPointerUp={endSession}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("input")) return;
          onFocusZoom(term.id);
        }}
        data-tip-wrap="" data-tip={`${term.program} ${term.args.join(" ")}\n${term.cwd}`}
      >
        <span className={`dot dot--${rt?.state ?? "idle"}`} />
        <TerminalMark term={term} size={12} />
        {renaming ? (
          <InlineRename
            value={label}
            onCommit={(next) => {
              updateTerminal(term.id, { title: next });
              onRenameEnd();
            }}
            onCancel={onRenameEnd}
          />
        ) : (
          <span
            className="cv-card-title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRenameStart(term.id);
            }}
          >
            {label}
          </span>
        )}
        {rect.pinned && (
          <span
            className="cv-card-pin"
            role="img"
            aria-label={t("Fixado no lugar")}
            data-tip={t("Fixado no lugar")}
          >
            <Pin size={10} />
          </span>
        )}
        {front && (
          // The front this card runs in. Clicking it is the lens: every card
          // of another front steps back, so a board with three worktrees
          // reads one worktree at a time.
          <button
            className={`cv-card-front ${frontFocus === "on" ? "is-active" : ""}`}
            style={{ background: front.color }}
            data-tip-wrap=""
            data-tip={
              frontFocus === "on"
                ? t("Frente: {name} · clique para tirar o destaque", { name: front.name })
                : t("Frente: {name} · clique para destacar as CLIs desta frente", {
                    name: front.name,
                  })
            }
            aria-pressed={frontFocus === "on"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onFocusFront(frontFocus === "on" ? null : front.id);
            }}
          >
            {front.name}
          </button>
        )}
        {role && (
          <span
            className="cv-card-role"
            data-tip-wrap=""
            data-tip={t("{text}\n\n(duplo clique edita)", { text: role.text ?? role.name })}
            onDoubleClick={(e) => {
              e.stopPropagation();
              openModal("role", { terminalId: term.id });
            }}
          >
            {role.name}
          </span>
        )}
        {routineCount > 0 && (
          <span
            className="cv-card-routine"
            data-tip-wrap="" data-tip={t("{n} rotina(s) ativa(s) neste terminal", { n: routineCount })}
            role="img"
            aria-label={t("{n} rotina(s) ativa(s) neste terminal", { n: routineCount })}
          >
            <Clock size={10} />
          </span>
        )}
        {flowMark && (
          <span
            className={`cv-card-flow is-${flowMark.status}`}
            data-tip-wrap=""
            data-tip={t('Fluxo "{name}" — etapa {step}/{total}: {status}', {
              name: flowMark.name,
              step: flowMark.step,
              total: flowMark.total,
              status: t(FLOW_STATUS_LABEL[flowMark.status]),
            })}
            role="img"
            aria-label={t('Fluxo "{name}" — etapa {step}/{total}: {status}', {
              name: flowMark.name,
              step: flowMark.step,
              total: flowMark.total,
              status: t(FLOW_STATUS_LABEL[flowMark.status]),
            })}
          >
            <Workflow size={9} />
            {flowMark.step}/{flowMark.total}
          </span>
        )}
        {/* What is parked for this CLI (`lib/queue.ts`), a count, because
            the size of the queue is the information. */}
        {queued > 0 && (
          <span
            className="pane-tab-queue"
            data-tip-wrap=""
            data-tip={t("{n} na fila, entram sozinhos quando a CLI ficar livre", {
              n: queued,
            })}
            role="img"
            aria-label={t("{n} prompt(s) na fila", { n: queued })}
          >
            <ListPlus size={9} />
            {queued}
          </span>
        )}
        {rt?.blocked ? (
          <span
            className="badge-blocked"
            data-tip-wrap=""
            data-tip={rt.blockedAsk ?? (rt.permission ? t("Pedindo permissão") : t("Esperando uma resposta sua"))}
            role="img"
            aria-label={rt.blockedAsk ?? (rt.permission ? t("Pedindo permissão") : t("Esperando uma resposta sua"))}
          />
        ) : rt?.finished ? (
          <span
            className="badge-finished"
            data-tip={t("Terminou de trabalhar")}
            role="img"
            aria-label={t("Terminou de trabalhar")}
          />
        ) : rt?.unread ? (
          <span className="badge-unread" data-tip={t("Saída nova")} role="img" aria-label={t("Saída nova")} />
        ) : null}
        <span className="cv-card-actions">
          {rt && rt.rssMb > 0 && (
            <span
              className="pane-stat"
              data-tip={t("RAM da árvore de processos")}
              role="img"
              aria-label={t("RAM da árvore de processos: {mb} MB", { mb: rt.rssMb.toFixed(0) })}
            >
              {rt.rssMb.toFixed(0)} MB
            </span>
          )}
          {served && served.length > 0 && (
            <button
              className="icon-btn icon-btn--served"
              data-tip-wrap=""
              data-tip={
                served.length === 1
                  ? t("Servindo em {origin} — abrir num portal", { origin: served[0].origin })
                  : t("{n} endereços anunciados — abrir num portal", { n: served.length })
              }
              aria-label={t("Abrir num portal o que este terminal está servindo")}
              onClick={(e) => {
                if (served.length === 1) {
                  openPortal(served[0].origin);
                  return;
                }
                const r = e.currentTarget.getBoundingClientRect();
                setPortalMenu({ x: r.right - 220, y: r.bottom + 4 });
              }}
            >
              <Globe size={13} />
            </button>
          )}
          {term.kind === "agent" && hasSession && (
            <button
              className="icon-btn live-launch"
              data-tip-wrap=""
              data-tip={t("Ao Vivo — arquivos, plano e sub-agents em tempo real")}
              aria-label={t("Abrir o Ao Vivo deste agente")}
              data-working={running || undefined}
              onClick={() => void useLive.getState().openFor(term)}
            >
              <Activity size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            data-tip={rect.restore ? t("Restaurar o tamanho") : t("Maximizar no canvas")}
            aria-label={rect.restore ? t("Restaurar o tamanho") : t("Maximizar no canvas")}
            onClick={() => onMaximize(term.id)}
          >
            {rect.restore ? <Minimize size={13} /> : <Maximize size={13} />}
          </button>
          <button
            className="icon-btn"
            data-tip={t("Compositor de prompts (Ctrl+Enter)")}
            aria-label={t("Abrir o compositor de prompts para este terminal")}
            onClick={() => {
              focusTerminal(term.id, term.slot);
              setComposerOpen(true);
            }}
          >
            <MessageSquarePlus size={13} />
          </button>
          {running ? (
            <button
              className="icon-btn"
              data-tip-wrap="" data-tip={t("Suspender — encerra o processo e guarda o histórico")}
              aria-label={t("Suspender")}
              onClick={() => void act(() => ipc.suspendPty(term.id), t("falha ao suspender"))}
            >
              <PauseCircle size={13} />
            </button>
          ) : (
            <button
              className="icon-btn icon-btn--go"
              data-tip={t("Iniciar ou retomar")}
              aria-label={t("Iniciar ou retomar")}
              onClick={() => void handleRef.current?.start()}
            >
              <Play size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            data-tip-at="right" data-tip={t("Mais ações")}
            aria-label={t("Mais ações deste terminal")}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 200, y: r.bottom + 4 });
            }}
          >
            <MoreVertical size={13} />
          </button>
        </span>
      </div>

      {/* Only alive under `.cv--far` (see styles.css): a transparent sheet that
          turns the whole card into a drag handle when the terminal is too
          small to read anyway. Kept out of the body's flow so it never touches
          xterm's layout — resizing the body would resize the PTY. */}
      <div
        className="cv-card-scrim"
        onPointerDown={(e) => startSession(e, "move")}
        onPointerMove={moveSession}
        onPointerUp={endSession}
        onDoubleClick={() => onFocusZoom(term.id)}
      >
        <span className="cv-card-hud-role">{role?.name ?? label}</span>
        <span className={`cv-card-hud-state is-${hudKind(rt)}`}>
          {hudLabel(rt)}
        </span>
        {rt?.blocked && rt.blockedAsk && (
          <span className="cv-card-hud-ask">{rt.blockedAsk}</span>
        )}
      </div>

      <div className="cv-card-body">
        <ExitBanner
          rt={rt}
          term={term}
          onStart={(extra) =>
            void handleRef.current?.start(
              extra ? { args: [...term.args, ...extra] } : undefined,
            )
          }
        />
        <div
          className="cv-card-scale"
          style={
            renderScale > 1
              ? {
                  flex: "none",
                  width: `${renderScale * 100}%`,
                  height: `${renderScale * 100}%`,
                  transform: `scale(${1 / renderScale})`,
                }
              : undefined
          }
        >
          <Suspense fallback={<div className="xterm-host" aria-hidden />}>
            <XTermView
              ref={setXtermRef}
              id={term.id}
              program={term.program}
              args={term.args}
              cwd={term.cwd}
              kind={term.kind}
              title={term.title || term.program}
              autoStart={term.alive}
              visible={visible}
              // Past 100% the glyphs are drawn `renderScale` times bigger and
              // the wrapper above shrinks them back: crisp, same columns.
              fontSize={renderScale > 1 ? Math.round(fontPx * renderScale) : rect.fontSize}
              onFocus={() => focusTerminal(term.id, term.slot)}
              // The terminal stops the right click before xterm sees it, so the
              // card's own `onContextMenu` never fires over the body.
              onContextMenu={(e) => setMenu({ x: e.clientX, y: e.clientY })}
            />
          </Suspense>
        </div>
      </div>

      {!rect.pinned && (
        <ResizeHandles
          onDown={(e, dir) => startSession(e, dir)}
          onMove={moveSession}
          onUp={endSession}
        />
      )}

      {menu && (
        <ContextMenu anchor={menu} items={menuItems()} onClose={() => setMenu(null)} />
      )}
      {portalMenu && served && (
        <ContextMenu
          anchor={portalMenu}
          items={served.map((u) => ({
            id: u.origin,
            label: u.origin,
            icon: <Globe size={13} />,
            onSelect: () => openPortal(u.origin),
          }))}
          onClose={() => setPortalMenu(null)}
        />
      )}
    </div>
  );
}

export const TerminalCard = memo(TerminalCardImpl);
