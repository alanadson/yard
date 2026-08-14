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
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Clock,
  Eraser,
  Maximize2,
  MessageSquarePlus,
  MoreVertical,
  PauseCircle,
  Play,
  Terminal as TerminalIcon,
  Type,
} from "lucide-react";

import { ExitBanner } from "../ExitBanner";
import { XTermView, type XTermHandle } from "../XTermView";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { InlineRename } from "../ContextMenu/InlineRename";
import { ResizeHandles } from "./ResizeHandles";
import { ipc, type TerminalRow } from "../../lib/ipc";
import { terminalActionEntries } from "../../lib/terminalMenu";
import { baseName } from "../../lib/terminals";
import { useAction } from "../../hooks/useAction";
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
  type RectPhase,
  type ResizeDir,
} from "../../lib/canvas";

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
  /** Role assigned to the agent (e.g. "revisora"), visible in `yard list`. */
  role?: string;
  onRole: (id: string, role: string) => void;
  /** How many active routines point at this terminal (header badge). */
  routineCount: number;
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

function TerminalCardImpl({
  term,
  rect,
  getZoom,
  focused,
  role,
  onRole,
  routineCount,
  connectRole,
  onRect,
  onColor,
  onFontSize,
  onFocusZoom,
  registerHandle,
  onMenuOpen,
}: Props) {
  const rt = useTerminals((s) => s.byId[term.id]);
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
  const [renaming, setRenaming] = useState(false);
  const [editingRole, setEditingRole] = useState(false);

  // The registration must survive unmount so the parent's map doesn't
  // accumulate dead handles.
  useEffect(() => () => registerHandle(term.id, null), [term.id, registerHandle]);

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
    focusTerminal(term.id, term.slot);
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
      label: "Fonte",
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
      label: `Encaixar fonte (~${FIT_COLS} colunas)`,
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
    ...(term.kind === "agent"
      ? ([
          {
            id: "live",
            label: "Ao Vivo — acompanhar o agente",
            icon: <Activity size={13} />,
            onSelect: () => void useLive.getState().openFor(term),
          },
        ] satisfies MenuEntry[])
      : []),
    {
      id: "role",
      label: role ? "Editar papel…" : "Definir papel…",
      icon: <Bot size={13} />,
      onSelect: () => setEditingRole(true),
    },
    {
      id: "routines",
      label: routineCount > 0 ? `Rotinas… (${routineCount})` : "Rotinas…",
      icon: <Clock size={13} />,
      onSelect: () =>
        openModal("routines", { groupId: term.groupId, terminalId: term.id }),
    },
    {
      id: "center",
      label: "Centralizar em 100%",
      icon: <Maximize2 size={13} />,
      onSelect: () => onFocusZoom(term.id),
    },
    {
      id: "clear",
      label: "Limpar terminal",
      icon: <Eraser size={13} />,
      onSelect: () => handleRef.current?.clear(),
    },
    { kind: "sep" },
    ...terminalActionEntries({
      id: term.id,
      running,
      run: act,
      onRename: () => setRenaming(true),
    }),
  ];


  return (
    <div
      className={`cv-card ${focused ? "is-focused" : ""} ${
        connectRole ? `is-connect-${connectRole}` : ""
      }`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
        onMenuOpen?.(true);
      }}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        // Inline would override the classes' focus/connect highlight; the
        // custom color only paints the frame when no highlight is active.
        ...(rect.color && !focused && !connectRole
          ? { borderColor: `color-mix(in srgb, ${rect.color} 45%, var(--border))` }
          : {}),
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
        {term.kind === "agent" ? <Bot size={12} /> : <TerminalIcon size={12} />}
        {renaming ? (
          <InlineRename
            value={label}
            onCommit={(next) => {
              updateTerminal(term.id, { title: next });
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span
            className="cv-card-title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(true);
            }}
          >
            {label}
          </span>
        )}
        {editingRole ? (
          <InlineRename
            value={role ?? ""}
            onCommit={(next) => {
              onRole(term.id, next);
              setEditingRole(false);
            }}
            onCancel={() => setEditingRole(false)}
          />
        ) : (
          role && (
            <span
              className="cv-card-role"
              data-tip-wrap="" data-tip={`Papel: ${role} (duplo clique edita)`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingRole(true);
              }}
            >
              {role}
            </span>
          )
        )}
        {routineCount > 0 && (
          <span
            className="cv-card-routine"
            data-tip-wrap="" data-tip={`${routineCount} rotina(s) ativa(s) neste terminal`}
          >
            <Clock size={10} />
          </span>
        )}
        {rt?.finished && (
          <span className="badge-finished" data-tip="Terminou de trabalhar" />
        )}
        {rt?.unread && !rt.finished && (
          <span className="badge-unread" data-tip="Saída nova" />
        )}
        <span className="cv-card-actions">
          {rt && rt.rssMb > 0 && (
            <span className="pane-stat" data-tip="RAM da árvore de processos">
              {rt.rssMb.toFixed(0)} MB
            </span>
          )}
          {term.kind === "agent" && (
            <button
              className="icon-btn live-launch"
              data-tip-wrap=""
              data-tip="Ao Vivo — arquivos, plano e sub-agents em tempo real"
              aria-label="Abrir o Ao Vivo deste agente"
              data-working={running || undefined}
              onClick={() => void useLive.getState().openFor(term)}
            >
              <Activity size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            data-tip="Compositor de prompts (Ctrl+Enter)"
            aria-label="Abrir o compositor de prompts para este terminal"
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
              data-tip-wrap="" data-tip="Suspender — encerra o processo e guarda o histórico"
              aria-label="Suspender"
              onClick={() => void act(() => ipc.suspendPty(term.id), "falha ao suspender")}
            >
              <PauseCircle size={13} />
            </button>
          ) : (
            <button
              className="icon-btn icon-btn--go"
              data-tip="Iniciar ou retomar"
              aria-label="Iniciar ou retomar"
              onClick={() => void handleRef.current?.start()}
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
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 200, y: r.bottom + 4 });
              onMenuOpen?.(true);
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
      />

      <div className="cv-card-body">
        <ExitBanner rt={rt} onStart={() => void handleRef.current?.start()} />
        <XTermView
          ref={setXtermRef}
          id={term.id}
          program={term.program}
          args={term.args}
          cwd={term.cwd}
          kind={term.kind}
          title={term.title || term.program}
          autoStart={term.alive}
          visible
          fontSize={rect.fontSize}
          onFocus={() => focusTerminal(term.id, term.slot)}
        />
      </div>

      <ResizeHandles
        onDown={(e, dir) => startSession(e, dir)}
        onMove={moveSession}
        onUp={endSession}
      />

      {menu && (
        <ContextMenu
          anchor={menu}
          items={menuItems()}
          onClose={() => {
            setMenu(null);
            onMenuOpen?.(false);
          }}
        />
      )}
    </div>
  );
}

export const TerminalCard = memo(TerminalCardImpl);
