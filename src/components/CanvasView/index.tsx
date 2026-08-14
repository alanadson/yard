/**
 * The infinite canvas (§F2-canvas): loose terminals as cards, freehand
 * drawing, notes, text and connections — living alongside the grid, never
 * in its place. The user picks the mode per group in the title bar.
 *
 * Layer architecture (bottom to top):
 *   dotted background -> DOM (notes, texts, cards) -> SVG (drawings) ->
 *   capture overlay (only with a drawing tool active) -> fixed UI.
 *
 * Zoom is a `transform: scale` on the whole world: xterm is not resized
 * on zoom (only resizing the card itself touches the PTY — §9.1, ConPTY
 * repaint is expensive). Text selection inside the terminal is only faithful
 * at 100%; that's why double-clicking the card header brings the camera to
 * 100% centered on it.
 *
 * Persisted state lives in `layout.canvas` (via `updateCanvas`); viewport
 * is committed at the end of the gesture so the workspace isn't serialized
 * every frame.
 *
 * Fluency — the three rules that keep the canvas at 60 fps:
 * - **A gesture only touches React once per frame.** pointermove and wheel can
 *   reach 1000 Hz; everything "live" (pan, zoom, drag, resize,
 *   drawing draft) accumulates in refs and drains into a single `setState`
 *   per rAF (`scheduleFrame`). The pen still collects the event's coalesced
 *   points so the stroke doesn't lose fidelity.
 * - **Stable identity.** The canvas persists as JSON; each commit returns
 *   a new graph. `reconcileItems`/`reconcileNodes` return the old
 *   references for what didn't change — a keystroke in a note re-renders the
 *   note, not every card, arrow and stroke.
 * - **Layers deaf to what isn't their business.** Cards, notes and vector
 *   items are memoized components; pan/zoom swap a transform, and the
 *   SVG lists are memoized without `vp`. That's why every callback passed to
 *   children from here is `useCallback` — a new function would break the
 *   bail-out on the hot path.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { nanoid } from "nanoid";
import {
  ArrowLeftRight,
  BringToFront,
  Copy,
  Expand,
  Globe,
  Lock,
  Maximize2,
  Pencil,
  Plus,
  SendToBack,
  StickyNote,
  Terminal as TerminalIcon,
  Trash2,
  Type,
  Unlock,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { CanvasToolbar, type Tool } from "./CanvasToolbar";
import {
  ContextMenu,
  type MenuAnchor,
  type MenuEntry,
  type MenuSwatches,
} from "../ContextMenu";
import { ConnectionsLayer } from "./ConnectionsLayer";
import { ItemsLayer } from "./ItemsLayer";
import { COMMIT_DEBOUNCE_MS, NoteItem, TextItem } from "./DomItems";
import { PortalCard } from "./PortalCard";
import { TerminalCard, type RectPhase } from "./TerminalCard";
import type { XTermHandle } from "../XTermView";
import { useChanges } from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { ipc, on, type TerminalRow } from "../../lib/ipc";
import { hostnameOf } from "../../lib/portals";
import {
  addItems,
  connection,
  patchItem as patchItemById,
  patchItemOfType,
  removeItemAndEdges,
  reorderItem as reorder,
  setEntry,
} from "../../lib/canvasOps";
import {
  autoNodeRect,
  clamp,
  CANVAS_COLORS,
  CANVAS_EXTERNAL_WRITE,
  EMPTY_CANVAS,
  hitItem,
  itemBounds,
  NOTE_MIN_H,
  NOTE_MIN_W,
  reconcileItems,
  reconcileNodes,
  resizeRect,
  translateItem,
  ZOOM_MAX,
  ZOOM_MIN,
  type Box,
  type CanvasData,
  type CanvasItem,
  type CanvasNode,
  type CanvasViewport,
  type ResizeDir,
  type StrokeSize,
} from "../../lib/canvas";

interface Props {
  groupId: string;
  terminals: TerminalRow[];
  canvas?: CanvasData;
}

type Draft =
  | { kind: "stroke"; points: number[] }
  | {
      kind: "shape";
      type: "rect" | "ellipse" | "line" | "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };

const DRAW_TOOLS: Tool[] = [
  "pen",
  "eraser",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "text",
  "note",
  "connect",
];

const TEXT_PX: Record<StrokeSize, number> = { s: 16, m: 22, l: 30 };
const GRID = 26;

/** Stroke-width/body rows shown in the item context menus. */
const MENU_STROKES = [
  { id: "s", dot: 3, label: "Traço fino" },
  { id: "m", dot: 5, label: "Traço médio" },
  { id: "l", dot: 8, label: "Traço grosso" },
] as const;
const MENU_FONTS = [
  { id: "s", dot: 3, label: "Texto pequeno" },
  { id: "m", dot: 5, label: "Texto médio" },
  { id: "l", dot: 8, label: "Texto grande" },
] as const;

function randSeed(): number {
  return Math.floor(Math.random() * 2 ** 31) + 1;
}

export function CanvasView({ groupId, terminals, canvas }: Props) {
  const updateCanvas = useProjects((s) => s.updateCanvas);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const openModal = useUI((s) => s.openModal);
  const modalOpen = useUI((s) => s.modal);
  const projectId = useProjects((s) => s.groups.find((g) => g.id === groupId)?.projectId ?? null);

  const data = canvas ?? EMPTY_CANVAS;

  // --- session state (none of this persists) ---
  const [vp, setVp] = useState<CanvasViewport>(
    () => canvas?.viewport ?? { ...EMPTY_CANVAS.viewport },
  );
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<string>(CANVAS_COLORS[0]);
  const [size, setSize] = useState<StrokeSize>("m");
  const [selection, setSelection] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [cursorWorld, setCursorWorld] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingErase, setPendingErase] = useState<Set<string>>(() => new Set());
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, CanvasNode>>({});
  const [itemDragDelta, setItemDragDelta] = useState<{
    id: string;
    dx: number;
    dy: number;
  } | null>(null);
  const [noteResize, setNoteResize] = useState<{
    id: string;
    w: number;
    h: number;
  } | null>(null);
  /**
   * Canvas context menu: `itemId` is the item under the click (null = background)
   * and `world` stores where to create whatever the background menu offers.
   */
  const [ctxMenu, setCtxMenu] = useState<{
    anchor: MenuAnchor;
    itemId: string | null;
    world: { x: number; y: number };
  } | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const containerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const handlesRef = useRef<Record<string, XTermHandle | null>>({});
  const undoRef = useRef<CanvasData[]>([]);
  const redoRef = useRef<CanvasData[]>([]);
  const draftSeed = useRef(randSeed());
  const panSess = useRef<{
    pointerId: number;
    cx: number;
    cy: number;
    vx: number;
    vy: number;
  } | null>(null);
  const itemSess = useRef<{ id: string; pointerId: number; sx: number; sy: number } | null>(
    null,
  );
  const noteSess = useRef<{
    id: string;
    pointerId: number;
    dir: ResizeDir;
    cx: number;
    cy: number;
    start: Box;
  } | null>(null);
  const vpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- per-frame scheduler ---
  // A bucket of "latest intent per key", emptied once per rAF. It's what
  // decouples the mouse rate (up to 1000 Hz) from the render rate: each gesture
  // writes the newest state into a ref and schedules the flush; React sees at
  // most one setState per frame. `cancelFrame` exists so the end of the gesture
  // isn't overrun by a late flush.
  const frameQ = useRef(new Map<string, () => void>());
  const frameRaf = useRef(0);
  useEffect(
    () => () => {
      if (frameRaf.current) cancelAnimationFrame(frameRaf.current);
    },
    [],
  );
  const scheduleFrame = useCallback((key: string, fn: () => void) => {
    frameQ.current.set(key, fn);
    if (frameRaf.current) return;
    frameRaf.current = requestAnimationFrame(() => {
      frameRaf.current = 0;
      const fns = [...frameQ.current.values()];
      frameQ.current.clear();
      for (const f of fns) f();
    });
  }, []);
  const cancelFrame = useCallback((key: string) => {
    frameQ.current.delete(key);
  }, []);

  const sorted = useMemo(
    () => [...terminals].sort((a, b) => a.sort - b.sort),
    [terminals],
  );

  // The canvas persists as JSON: each commit re-parses and would return new
  // objects for EVERYTHING, killing the children's memos. Reconciliation
  // returns the old references for what didn't change in content.
  const prevItemsRef = useRef<CanvasItem[]>([]);
  const items = useMemo(() => {
    const next = reconcileItems(prevItemsRef.current, data.items);
    prevItemsRef.current = next;
    return next;
  }, [data.items]);

  const prevNodesRef = useRef<Record<string, CanvasNode>>({});
  const nodes = useMemo(() => {
    const next = reconcileNodes(prevNodesRef.current, data.nodes);
    prevNodesRef.current = next;
    return next;
  }, [data.nodes]);

  // Stable automatic positions: generating `autoNodeRect` inside the `rects`
  // memo would create a new object per recompute — and every drag frame
  // would re-render the cards that were never moved.
  const autoRects = useMemo(() => sorted.map((_, i) => autoNodeRect(i)), [sorted]);

  const rects = useMemo(() => {
    const m: Record<string, CanvasNode> = {};
    sorted.forEach((t, i) => {
      m[t.id] = nodeOverrides[t.id] ?? nodes[t.id] ?? autoRects[i];
    });
    return m;
  }, [sorted, nodes, nodeOverrides, autoRects]);
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  // Dragging/resizing a note only touches its own DOM until pointerup; the
  // anchors need the same "live" state, otherwise the arrow detaches from the
  // note and only jumps into place at the end of the gesture. Filtering by type
  // keeps dragging a stroke or text out of this memo (none of those anchor a connection).
  const noteDrag = useMemo(() => {
    if (!itemDragDelta) return null;
    const it = items.find((i) => i.id === itemDragDelta.id);
    return it?.type === "note" || it?.type === "portal" ? itemDragDelta : null;
  }, [itemDragDelta, items]);

  // Connection anchors: cards AND notes — a note<->CLI connection is what
  // turns the note into live context for the agent (via the `yard` CLI).
  //
  // Reconciled like `nodes`: the note/portal rectangles are computed fresh
  // here, and without reusing the previous object every wire touching a note
  // would recompute its bezier on every frame of any gesture — exactly what
  // the memo on `<Connection>` exists to avoid.
  const prevAnchorsRef = useRef<Record<string, CanvasNode>>({});
  const anchors = useMemo(() => {
    const m: Record<string, CanvasNode> = { ...rects };
    for (const it of items) {
      if (it.type !== "note" && it.type !== "portal") continue;
      const live = noteResize?.id === it.id ? noteResize : null;
      const shift = noteDrag?.id === it.id ? noteDrag : null;
      m[it.id] = {
        x: it.x + (shift?.dx ?? 0),
        y: it.y + (shift?.dy ?? 0),
        w: live?.w ?? it.w,
        h: live?.h ?? it.h,
      };
    }
    const next = reconcileNodes(prevAnchorsRef.current, m);
    prevAnchorsRef.current = next;
    return next;
  }, [rects, items, noteDrag, noteResize]);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  // --- persistence / undo ---

  const currentData = useCallback((): CanvasData => {
    return useProjects.getState().layoutOf(groupId).canvas ?? EMPTY_CANVAS;
  }, [groupId]);

  const pushUndo = useCallback(() => {
    undoRef.current.push(currentData());
    if (undoRef.current.length > 60) undoRef.current.shift();
    redoRef.current = [];
    bump();
  }, [currentData]);

  const commit = useCallback(
    (fn: (c: CanvasData) => CanvasData, opts?: { undo?: boolean }) => {
      if (opts?.undo !== false) pushUndo();
      updateCanvas(groupId, (c) => ({ ...fn(c), viewport: { ...vpRef.current } }));
    },
    [groupId, pushUndo, updateCanvas],
  );

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(currentData());
    updateCanvas(groupId, () => ({ ...prev }));
    setSelection(null);
    bump();
  }, [currentData, groupId, updateCanvas]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(currentData());
    updateCanvas(groupId, () => ({ ...next }));
    setSelection(null);
    bump();
  }, [currentData, groupId, updateCanvas]);

  /**
   * A write coming from outside the user (CLI `yard`, routine) invalidates
   * this group's history.
   *
   * Undo stores snapshots of the whole canvas. If an agent writes in a note
   * and the user hits Ctrl+Z right after — undoing their *own* earlier
   * stroke — the restored snapshot would take the note with it and erase the
   * agent's work without anyone asking. Losing history is the lesser evil,
   * and it's obvious: the undo arrow goes blank in the bar.
   */
  useEffect(() => {
    const onExternal = (e: Event) => {
      const detail = (e as CustomEvent<{ groupId?: string }>).detail;
      if (detail?.groupId && detail.groupId !== groupId) return;
      if (!undoRef.current.length && !redoRef.current.length) return;
      undoRef.current = [];
      redoRef.current = [];
      bump();
    };
    window.addEventListener(CANVAS_EXTERNAL_WRITE, onExternal);
    return () => window.removeEventListener(CANVAS_EXTERNAL_WRITE, onExternal);
  }, [groupId]);

  const scheduleVpCommit = useCallback(() => {
    if (vpTimer.current) clearTimeout(vpTimer.current);
    vpTimer.current = setTimeout(() => {
      vpTimer.current = null;
      updateCanvas(groupId, (c) => ({ ...c, viewport: { ...vpRef.current } }));
    }, 500);
  }, [groupId, updateCanvas]);

  // A pending viewport must not be lost when switching group/mode.
  useEffect(
    () => () => {
      if (vpTimer.current) {
        clearTimeout(vpTimer.current);
        updateCanvas(groupId, (c) => ({ ...c, viewport: { ...vpRef.current } }));
      }
    },
    [groupId, updateCanvas],
  );

  // --- viewport ---

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    const v = vpRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: (clientX - r.left) / v.zoom + v.x,
      y: (clientY - r.top) / v.zoom + v.y,
    };
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setVp((v) => {
        let z = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
        // Snap to 100%: the only zoom where the terminal is pixel-perfect.
        if (Math.abs(z - 1) < 0.04) z = 1;
        const px = clientX - r.left;
        const py = clientY - r.top;
        const wx = px / v.zoom + v.x;
        const wy = py / v.zoom + v.y;
        return { zoom: z, x: wx - px / z, y: wy - py / z };
      });
      scheduleVpCommit();
    },
    [scheduleVpCommit],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    },
    [zoomAt],
  );

  /** Jumps to an absolute zoom keeping whatever is at the center, centered. */
  const zoomToLevel = useCallback(
    (level: number) => {
      const el = containerRef.current;
      if (!el) return;
      const zl = clamp(level, ZOOM_MIN, ZOOM_MAX);
      setVp((v) => {
        const cx = v.x + el.clientWidth / v.zoom / 2;
        const cy = v.y + el.clientHeight / v.zoom / 2;
        return {
          zoom: zl,
          x: cx - el.clientWidth / zl / 2,
          y: cy - el.clientHeight / zl / 2,
        };
      });
      scheduleVpCommit();
    },
    [scheduleVpCommit],
  );

  const zoomTo100 = useCallback(() => zoomToLevel(1), [zoomToLevel]);

  const fitView = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const boxes: Box[] = Object.values(rectsRef.current).map((r) => ({ ...r }));
    for (const it of currentData().items) {
      const b = itemBounds(it, (id) => anchorsRef.current[id]);
      if (b) boxes.push(b);
    }
    if (boxes.length === 0) {
      setVp({ x: -60, y: -60, zoom: 1 });
      scheduleVpCommit();
      return;
    }
    const bx = Math.min(...boxes.map((b) => b.x));
    const by = Math.min(...boxes.map((b) => b.y));
    const bw = Math.max(...boxes.map((b) => b.x + b.w)) - bx;
    const bh = Math.max(...boxes.map((b) => b.y + b.h)) - by;
    const pad = 60;
    const zoom = clamp(
      Math.min(el.clientWidth / (bw + pad * 2), el.clientHeight / (bh + pad * 2)),
      ZOOM_MIN,
      1.25,
    );
    setVp({
      zoom,
      x: bx - (el.clientWidth / zoom - bw) / 2,
      y: by - (el.clientHeight / zoom - bh) / 2,
    });
    scheduleVpCommit();
  }, [currentData, scheduleVpCommit]);

  const focusNode = useCallback(
    (id: string) => {
      const el = containerRef.current;
      const r = rectsRef.current[id] ?? anchorsRef.current[id];
      if (!el || !r) return;
      setVp({
        zoom: 1,
        x: r.x + r.w / 2 - el.clientWidth / 2,
        y: r.y + r.h / 2 - el.clientHeight / 2,
      });
      scheduleVpCommit();
      const t = sorted.find((x) => x.id === id);
      focusTerminal(id, t?.slot ?? 0);
      setTimeout(() => handlesRef.current[id]?.focus(), 60);
    },
    [focusTerminal, scheduleVpCommit, sorted],
  );

  /** Zoom read at gesture time — changing it renders no cards. */
  const getZoom = useCallback(() => vpRef.current.zoom, []);

  // First visit to canvas mode: frame whatever is there.
  useEffect(() => {
    if (!canvas) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      void ipc.portalHideExcept([]).catch(() => {});
    };
  }, [groupId]);

  useEffect(() => {
    let gone = false;
    const uns: Array<() => void> = [];
    const keep = (u: () => void) => {
      if (gone) u();
      else uns.push(u);
    };
    void on
      .portalNav((p) => {
        if (gone) return;
        updateCanvas(groupId, (c) => ({
          ...c,
          items: c.items.map((i) =>
            i.type === "portal" && i.id === p.id ? { ...i, url: p.url } : i,
          ),
        }));
      })
      .then(keep);
    void on
      .portalPopup((p) => {
        if (gone) return;
        const parent = (useProjects.getState().layoutOf(groupId).canvas?.items ?? []).find(
          (i) => i.type === "portal" && i.id === p.parentId,
        );
        if (!parent || parent.type !== "portal") return;
        const id = nanoid(8);
        commit((c) =>
          addItems(
            c,
            {
              id,
              type: "portal" as const,
              x: parent.x + 40,
              y: parent.y + 40,
              w: parent.w,
              h: parent.h,
              url: p.url,
              color: parent.color,
              engine: parent.engine,
              storage: parent.storage,
              name: hostnameOf(p.url),
            },
            connection(parent.id, id),
          ),
        );
      })
      .then(keep);
    void on
      .portalEscape(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        containerRef.current?.focus?.();
      })
      .then(keep);
    return () => {
      gone = true;
      uns.forEach((u) => u());
    };
  }, [commit, groupId, updateCanvas]);

  // Keyboard focus (Ctrl+1..9 etc.) needs to reach the card's xterm.
  useEffect(() => {
    if (focusedTerminalId && rectsRef.current[focusedTerminalId]) {
      handlesRef.current[focusedTerminalId]?.focus();
    }
  }, [focusedTerminalId]);

  // --- wheel: zoom (Ctrl) and pan (without Ctrl) ---
  // Deltas accumulate between frames: a trackpad dumps dozens of events
  // per second and each one used to cost a full render. The flush applies the
  // sum — same total pan/zoom, a fraction of the renders.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const acc = { px: 0, py: 0, dz: 0, cx: 0, cy: 0 };
    const flush = () => {
      const { px, py, dz, cx, cy } = acc;
      acc.px = acc.py = acc.dz = 0;
      if (dz) zoomAt(cx, cy, Math.exp(-dz * 0.0022));
      if (px || py) {
        setVp((v) => ({ ...v, x: v.x + px / v.zoom, y: v.y + py / v.zoom }));
        scheduleVpCommit();
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        acc.dz += e.deltaY;
        acc.cx = e.clientX;
        acc.cy = e.clientY;
        scheduleFrame("wheel", flush);
        return;
      }
      const t = e.target as HTMLElement;
      // Wheel over the terminal scrolls its scrollback; over a note, the text.
      if (t.closest(".xterm") || t.closest(".cv-note")) return;
      e.preventDefault();
      if (e.shiftKey) {
        acc.px += e.deltaY;
      } else {
        acc.px += e.deltaX;
        acc.py += e.deltaY;
      }
      scheduleFrame("wheel", flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scheduleFrame, scheduleVpCommit, zoomAt]);

  // --- drawing draft ---
  // The ref is the truth during the gesture (pointerup reads from it, never
  // from state, which may be a frame behind); state exists only to paint.
  const draftRef = useRef<Draft | null>(null);
  const flushDraft = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    // The stroke mutates `points` in-place; state takes a copy so React
    // sees the change. Shapes are already born new on every move.
    setDraft(d.kind === "stroke" ? { kind: "stroke", points: d.points.slice() } : d);
  }, []);

  const clearDraft = useCallback(() => {
    draftRef.current = null;
    cancelFrame("draft");
    setDraft(null);
  }, [cancelFrame]);

  // --- keyboard: tools, delete, undo, space-pan ---
  //
  // The handler reads the live gesture state through refs, never through the
  // effect's dependencies. `draft` changes on every animation frame while the
  // pen is down: as a dependency it tore down and re-armed two window
  // listeners 60 times a second, during the one gesture this file is built
  // to keep smooth.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const connectFromRef = useRef(connectFrom);
  connectFromRef.current = connectFrom;

  useEffect(() => {
    const deleteSelection = () => {
      const dead = selectionRef.current;
      if (!dead) return;
      const it = currentData().items.find((i) => i.id === dead);
      if (it?.type === "portal") void ipc.portalClose(dead).catch(() => {});
      commit((c) => removeItemAndEdges(c, dead));
      setSelection(null);
    };

    /**
     * Arrow keys: 1px of world, 10 with Shift — the precision drag can't give.
     * Only the first key of a burst opens an undo entry; held down, the whole
     * slide collapses into one, instead of eating the 60-snapshot history.
     */
    const nudge = (dx: number, dy: number, repeat: boolean) => {
      const id = selectionRef.current;
      if (!id) return;
      commit((c) => patchItemById(c, id, (i) => translateItem(i, dx, dy)), {
        undo: !repeat,
      });
    };

    const duplicateSelection = () => {
      const sel = selectionRef.current;
      if (!sel) return;
      const src = currentData().items.find((i) => i.id === sel);
      if (!src || src.type === "connection") return;
      const copy = { ...translateItem(src, 24, 24), id: nanoid(8) };
      commit((c) => addItems(c, copy));
      setSelection(copy.id);
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing =
        t.closest?.(".xterm") ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.isContentEditable;
      if (typing) {
        if (e.key === "Escape" && !t.closest(".xterm")) (t as HTMLElement).blur();
        return;
      }
      if (useUI.getState().modal || useChanges.getState().viewer) return;

      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) {
        e.preventDefault();
        redo();
        return;
      }
      // Zoom with the keyboard. Ctrl+1..9 is taken by the global shortcuts
      // (focus the nth terminal), so framing lives on Shift+1 instead.
      if (ctrl && (e.code === "Digit0" || e.code === "Numpad0")) {
        e.preventDefault();
        zoomTo100();
        return;
      }
      if (ctrl && (e.code === "Equal" || e.code === "NumpadAdd")) {
        e.preventDefault();
        zoomBy(1.25);
        return;
      }
      if (ctrl && (e.code === "Minus" || e.code === "NumpadSubtract")) {
        e.preventDefault();
        zoomBy(1 / 1.25);
        return;
      }
      if (ctrl && !e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (ctrl) return; // Ctrl+T and friends belong to the global shortcuts

      if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        fitView();
        return;
      }

      if (e.code === "Space") {
        if (!e.repeat) setSpaceHeld(true);
        e.preventDefault();
        return;
      }

      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (arrows[e.code]) {
        if (!selectionRef.current) return;
        e.preventDefault();
        nudge(arrows[e.code][0], arrows[e.code][1], e.repeat);
        return;
      }

      const toolByKey: Record<string, Tool> = {
        KeyV: "select",
        KeyH: "pan",
        KeyP: "pen",
        KeyE: "eraser",
        KeyR: "rect",
        KeyO: "ellipse",
        KeyL: "line",
        KeyA: "arrow",
        KeyT: "text",
        KeyN: "note",
        KeyW: "portal",
        KeyC: "connect",
      };
      if (toolByKey[e.code]) {
        setTool(toolByKey[e.code]);
        setConnectFrom(null);
        return;
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        deleteSelection();
        return;
      }
      if (e.code === "Escape") {
        if (draftRef.current) clearDraft();
        else if (connectFromRef.current) setConnectFrom(null);
        else if (selectionRef.current) setSelection(null);
        else setTool("select");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [clearDraft, commit, currentData, fitView, redo, undo, zoomBy, zoomTo100]);

  // --- pan (background, middle button, space, hand tool) ---

  const panLast = useRef({ x: 0, y: 0 });
  const flushPan = useCallback(() => {
    const p = panSess.current;
    if (!p) return;
    const z = vpRef.current.zoom;
    setVp((v) => ({
      ...v,
      x: p.vx - (panLast.current.x - p.cx) / z,
      y: p.vy - (panLast.current.y - p.cy) / z,
    }));
  }, []);

  const onContainerPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // The fixed UI (toolbar, zoom) never becomes pan: capturing the pointer
    // here would swallow the button click.
    if (target.closest(".cv-toolbar, .cv-zoomctl")) return;
    // Clicking outside closes the note/text being edited. We can't wait for the
    // native blur: the pan's `preventDefault` (just below) suppresses the
    // compatibility mousedown — which is exactly what would take focus off the
    // textarea. Without this the note stays as raw text forever, never
    // rendering the markdown. A click on a terminal or button truly blurs and
    // falls into `onBlur`.
    if (editingId && !target.closest(".cv-note, .cv-text")) finishEditing();
    if (tool === "portal" && e.button === 0 && !spaceHeld) {
      const onEmpty =
        target === containerRef.current || target.classList.contains("cv-bg");
      if (onEmpty) {
        e.preventDefault();
        const w = toWorld(e.clientX, e.clientY);
        openModal("new-portal", { groupId, x: w.x, y: w.y });
        setTool("select");
        return;
      }
    }
    const onBg =
      target === containerRef.current || target.classList.contains("cv-bg");
    const middle = e.button === 1;
    const panIntent =
      middle ||
      (e.button === 0 && (spaceHeld || tool === "pan" || (tool === "select" && onBg)));
    if (!panIntent) return;
    e.preventDefault();
    if (tool === "select" && onBg && !middle && !spaceHeld) {
      setSelection(null);
      setConnectFrom(null);
    }
    panSess.current = {
      pointerId: e.pointerId,
      cx: e.clientX,
      cy: e.clientY,
      vx: vpRef.current.x,
      vy: vpRef.current.y,
    };
    setPanning(true);
    containerRef.current?.setPointerCapture(e.pointerId);
  };

  const onContainerPointerMove = (e: React.PointerEvent) => {
    const p = panSess.current;
    if (!p || e.pointerId !== p.pointerId) return;
    panLast.current = { x: e.clientX, y: e.clientY };
    scheduleFrame("pan", flushPan);
  };

  const onContainerPointerUp = (e: React.PointerEvent) => {
    const p = panSess.current;
    if (!p || e.pointerId !== p.pointerId) return;
    panSess.current = null;
    cancelFrame("pan");
    const z = vpRef.current.zoom;
    setVp((v) => ({
      ...v,
      x: p.vx - (e.clientX - p.cx) / z,
      y: p.vy - (e.clientY - p.cy) / z,
    }));
    setPanning(false);
    scheduleVpCommit();
  };

  // --- items: select and drag (selection tool) ---

  const itemLast = useRef({ x: 0, y: 0 });
  const flushItemDrag = useCallback(() => {
    const s = itemSess.current;
    if (!s) return;
    const w = toWorld(itemLast.current.x, itemLast.current.y);
    setItemDragDelta({ id: s.id, dx: w.x - s.sx, dy: w.y - s.sy });
  }, [toWorld]);

  const onItemDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (tool !== "select" || e.button !== 0) return;
      e.stopPropagation();
      setSelection(id);
      const w = toWorld(e.clientX, e.clientY);
      itemSess.current = { id, pointerId: e.pointerId, sx: w.x, sy: w.y };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [tool, toWorld],
  );

  const onItemMove = useCallback(
    (e: React.PointerEvent) => {
      const s = itemSess.current;
      if (!s || e.pointerId !== s.pointerId) return;
      itemLast.current = { x: e.clientX, y: e.clientY };
      scheduleFrame("item", flushItemDrag);
    },
    [flushItemDrag, scheduleFrame],
  );

  const onItemUp = useCallback(
    (e: React.PointerEvent) => {
      const s = itemSess.current;
      if (!s || e.pointerId !== s.pointerId) return;
      itemSess.current = null;
      cancelFrame("item");
      const w = toWorld(e.clientX, e.clientY);
      const dx = w.x - s.sx;
      const dy = w.y - s.sy;
      setItemDragDelta(null);
      if (Math.hypot(dx, dy) > 0.5) {
        commit((c) => patchItemById(c, s.id, (i) => translateItem(i, dx, dy)));
      }
    },
    [cancelFrame, commit, toWorld],
  );

  // --- drawing overlay ---

  // Cards first (they sit on top), notes after.
  const anchorAt = useCallback(
    (w: { x: number; y: number }): string | null => {
      const inside = (r: CanvasNode) =>
        w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const r = rectsRef.current[sorted[i].id];
        if (r && inside(r)) return sorted[i].id;
      }
      for (const it of items) {
        if (
          (it.type === "note" || it.type === "portal") &&
          inside({ x: it.x, y: it.y, w: it.w, h: it.h })
        )
          return it.id;
      }
      return null;
    },
    [items, sorted],
  );

  // Cursor/hover only matter once a connection origin is chosen (that's what
  // the pending line and the target highlight paint). Otherwise, moving the
  // mouse with a drawing tool active should not cost any state.
  const connectLast = useRef({ x: 0, y: 0 });
  const flushConnect = useCallback(() => {
    const w = toWorld(connectLast.current.x, connectLast.current.y);
    setCursorWorld(w);
    setHoverNode(anchorAt(w));
  }, [anchorAt, toWorld]);

  const pendingEraseRef = useRef(pendingErase);
  pendingEraseRef.current = pendingErase;

  const eraseAt = (w: { x: number; y: number }) => {
    const tol = 6 / vpRef.current.zoom;
    const hits = currentData().items.filter(
      (it) =>
        !pendingEraseRef.current.has(it.id) &&
        hitItem(it, w.x, w.y, tol, (id) => anchorsRef.current[id]),
    );
    if (hits.length) {
      setPendingErase((prev) => {
        const next = new Set(prev);
        hits.forEach((h) => next.add(h.id));
        return next;
      });
    }
  };

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (spaceHeld) return; // space-pan bubbles up to the container
    // Without this the compatibility `mousedown` fires right after this
    // handler and the browser runs its default focus: since the target (this
    // div) is not focusable, it *clears* focus — killing the `<textarea>` we
    // just mounted for text/note. See the same care in
    // `.cv-note-read`.
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    switch (tool) {
      case "pen": {
        const d: Draft = { kind: "stroke", points: [w.x, w.y] };
        draftRef.current = d;
        setDraft({ kind: "stroke", points: [w.x, w.y] });
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        break;
      }
      case "rect":
      case "ellipse":
      case "line":
      case "arrow": {
        draftSeed.current = randSeed();
        const d: Draft = { kind: "shape", type: tool, x1: w.x, y1: w.y, x2: w.x, y2: w.y };
        draftRef.current = d;
        setDraft(d);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        break;
      }
      case "eraser":
        eraseAt(w);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        break;
      case "text": {
        const id = nanoid(8);
        commit((c) => ({
          ...c,
          items: [
            ...c.items,
            { id, type: "text", x: w.x, y: w.y, text: "", fontSize: TEXT_PX[size], color },
          ],
        }));
        setTool("select");
        setSelection(id);
        setEditingId(id);
        break;
      }
      case "note": {
        const id = nanoid(8);
        commit((c) => ({
          ...c,
          items: [
            ...c.items,
            { id, type: "note", x: w.x, y: w.y, w: 230, h: 170, text: "", color },
          ],
        }));
        setTool("select");
        setSelection(id);
        setEditingId(id);
        break;
      }
      case "connect": {
        const nid = anchorAt(w);
        if (!nid) {
          setConnectFrom(null);
          break;
        }
        if (!connectFrom) {
          setConnectFrom(nid);
          // The pending line is born at the cursor, without waiting for the 1st move.
          setCursorWorld(w);
        } else if (connectFrom !== nid) {
          const from = connectFrom;
          const exists = currentData().items.some(
            (i) => i.type === "connection" && i.from === from && i.to === nid,
          );
          if (!exists) {
            commit((c) => addItems(c, connection(from, nid, color)));
          }
          setConnectFrom(null);
        } else {
          setConnectFrom(null);
        }
        break;
      }
      default:
        break;
    }
  };

  const onOverlayPointerMove = (e: React.PointerEvent) => {
    if (tool === "connect") {
      if (connectFrom) {
        connectLast.current = { x: e.clientX, y: e.clientY };
        scheduleFrame("connect", flushConnect);
      }
      return;
    }
    if (tool === "eraser") {
      if ((e.buttons & 1) === 1) eraseAt(toWorld(e.clientX, e.clientY));
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    if (d.kind === "stroke") {
      // Pointermove arrives coalesced: the browser only delivers the last
      // event and keeps the intermediates. For the stroke, the intermediates
      // ARE the drawing — without them a fast curve becomes a straight segment.
      const ne = e.nativeEvent;
      const coalesced =
        typeof ne.getCoalescedEvents === "function" ? ne.getCoalescedEvents() : null;
      const evs: PointerEvent[] = coalesced && coalesced.length ? coalesced : [ne];
      const pts = d.points;
      const min = 1.2 / vpRef.current.zoom;
      let added = false;
      for (const ev of evs) {
        const w = toWorld(ev.clientX, ev.clientY);
        const lx = pts[pts.length - 2];
        const ly = pts[pts.length - 1];
        if (Math.hypot(w.x - lx, w.y - ly) > min) {
          pts.push(w.x, w.y);
          added = true;
        }
      }
      if (added) scheduleFrame("draft", flushDraft);
    } else {
      const w = toWorld(e.clientX, e.clientY);
      draftRef.current = { ...d, x2: w.x, y2: w.y };
      scheduleFrame("draft", flushDraft);
    }
  };

  const onOverlayPointerUp = () => {
    if (tool === "eraser") {
      const dead = pendingEraseRef.current;
      if (dead.size) {
        commit((c) => ({ ...c, items: c.items.filter((i) => !dead.has(i.id)) }));
      }
      setPendingErase(new Set());
      return;
    }
    // The ref has the points that haven't reached state yet (pending flush).
    const d = draftRef.current;
    if (!d) return;
    clearDraft();
    if (d.kind === "stroke") {
      if (d.points.length >= 6) {
        const item: CanvasItem = {
          id: nanoid(8),
          type: "stroke",
          points: d.points,
          size,
          color,
        };
        commit((c) => addItems(c, item));
      }
      return;
    }
    const w = Math.abs(d.x2 - d.x1);
    const h = Math.abs(d.y2 - d.y1);
    if (d.type === "line" || d.type === "arrow") {
      if (Math.hypot(w, h) < 4) return;
      const item: CanvasItem = {
        id: nanoid(8),
        type: d.type,
        x1: d.x1,
        y1: d.y1,
        x2: d.x2,
        y2: d.y2,
        size,
        color,
        seed: draftSeed.current,
      };
      commit((c) => addItems(c, item));
      return;
    }
    if (w < 4 || h < 4) return;
    const item: CanvasItem = {
      id: nanoid(8),
      type: d.type,
      x: Math.min(d.x1, d.x2),
      y: Math.min(d.y1, d.y2),
      w,
      h,
      size,
      color,
      seed: draftSeed.current,
    };
    commit((c) => addItems(c, item));
  };

  // --- text and note (DOM layer) ---
  // Everything here is `useCallback` because it goes down to memoized
  // `NoteItem`/`TextItem`: a new function per render would take the notes
  // out of the bail-out on the very pan/drag frames that memoization exists to save.

  const beginTextEdit = useCallback(
    (id: string) => {
      if (editingIdRef.current !== id) {
        pushUndo();
        setEditingId(id);
      }
    },
    [pushUndo],
  );

  /**
   * Focus for the textarea that just came on stage, with the cursor at the end.
   *
   * `useCallback` is not decoration: an inline ref would be a new function
   * every render, and React would call it again on every keystroke —
   * repositioning the cursor at the end mid-typing. The cursor goes to the
   * end (and not to `autoFocus`'s 0) because the note's reading view is
   * rendered markdown: there's no way to map the click back to an offset in
   * the raw text, and annotating is almost always appending.
   */
  const focusAtEnd = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const patchText = useCallback(
    (id: string, text: string) => {
      commit(
        (c) =>
          patchItemById(c, id, (i) =>
            i.type === "text" || i.type === "note" ? { ...i, text } : i,
          ),
        { undo: false },
      );
    },
    [commit],
  );

  /**
   * Locking is about the CLI, not the user: a locked note stays
   * editable here and starts refusing `note write/edit/delete` from the
   * bridge. It's the way to give an agent a briefing without it rewriting it.
   */
  const toggleLock = useCallback(
    (id: string) => {
      commit((c) =>
        patchItemById(c, id, (i) =>
          i.type === "note" ? { ...i, locked: !i.locked } : i,
        ),
      );
    },
    [commit],
  );

  const endTextEdit = useCallback(
    (it: CanvasItem) => {
      // Functional form on purpose: the same pointerdown can close one
      // note's edit and open another's (creating a new note while another is
      // being edited). Setting null directly would wipe the `editingId` the
      // other handler just set, depending on the order the two run.
      setEditingId((cur) => (cur === it.id ? null : cur));
      // An empty note survives (it can be filled later); empty text disappears.
      if (it.type !== "text") return;
      // Deferred, and re-reading from the store: the typed text reaches the
      // canvas on a debounce, so the item handed to us here can still be one
      // commit behind. Deciding "it is empty, delete it" on that stale value
      // would throw away a word the user typed and immediately clicked away from.
      setTimeout(() => {
        const live = currentData().items.find((i) => i.id === it.id);
        if (live?.type !== "text" || live.text.trim() !== "") return;
        commit((c) => ({ ...c, items: c.items.filter((i) => i.id !== it.id) }), {
          undo: false,
        });
        setSelection((cur) => (cur === it.id ? null : cur));
      }, COMMIT_DEBOUNCE_MS + 60);
    },
    [commit, currentData],
  );

  const selectItem = useCallback((id: string) => setSelection(id), []);

  /** Closes the in-progress edit by id, looking up the item in current state. */
  const finishEditing = () => {
    const id = editingIdRef.current;
    if (!id) return;
    const it = currentData().items.find((i) => i.id === id);
    if (it) endTextEdit(it);
    else setEditingId(null);
  };

  const noteResizeLast = useRef({ x: 0, y: 0 });

  /**
   * The note's rectangle for the current pointer. Pulling the north or west
   * side moves the note as it resizes, so the live preview needs both the
   * size (`noteResize`) and the offset (`itemDragDelta`) — the same pair the
   * `anchors` memo already reads to keep connections glued during a gesture.
   */
  const noteRectNow = useCallback((cx: number, cy: number): Box | null => {
    const s = noteSess.current;
    if (!s) return null;
    const z = vpRef.current.zoom;
    return resizeRect(
      s.start,
      s.dir,
      (cx - s.cx) / z,
      (cy - s.cy) / z,
      NOTE_MIN_W,
      NOTE_MIN_H,
    );
  }, []);

  const flushNoteResize = useCallback(() => {
    const s = noteSess.current;
    const r = noteRectNow(noteResizeLast.current.x, noteResizeLast.current.y);
    if (!s || !r) return;
    setNoteResize({ id: s.id, w: r.w, h: r.h });
    const dx = r.x - s.start.x;
    const dy = r.y - s.start.y;
    setItemDragDelta(dx || dy ? { id: s.id, dx, dy } : null);
  }, [noteRectNow]);

  const startNoteResize = useCallback(
    (e: React.PointerEvent, it: Extract<CanvasItem, { type: "note" }>, dir: ResizeDir) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      noteSess.current = {
        id: it.id,
        pointerId: e.pointerId,
        dir,
        cx: e.clientX,
        cy: e.clientY,
        start: { x: it.x, y: it.y, w: it.w, h: it.h },
      };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [],
  );

  const moveNoteResize = useCallback(
    (e: React.PointerEvent) => {
      const s = noteSess.current;
      if (!s || e.pointerId !== s.pointerId) return;
      noteResizeLast.current = { x: e.clientX, y: e.clientY };
      scheduleFrame("nres", flushNoteResize);
    },
    [flushNoteResize, scheduleFrame],
  );

  const endNoteResize = useCallback(
    (e: React.PointerEvent) => {
      const s = noteSess.current;
      if (!s || e.pointerId !== s.pointerId) return;
      const r = noteRectNow(e.clientX, e.clientY);
      noteSess.current = null;
      cancelFrame("nres");
      setNoteResize(null);
      setItemDragDelta(null);
      if (!r) return;
      const moved =
        Math.abs(r.w - s.start.w) > 0.5 ||
        Math.abs(r.h - s.start.h) > 0.5 ||
        Math.abs(r.x - s.start.x) > 0.5 ||
        Math.abs(r.y - s.start.y) > 0.5;
      if (!moved) return;
      commit((c) =>
        patchItemById(c, s.id, (i) =>
          i.type === "note" ? { ...i, x: r.x, y: r.y, w: r.w, h: r.h } : i,
        ),
      );
    },
    [cancelFrame, commit, noteRectNow],
  );

  // --- cards ---

  const nodeLive = useRef<{ id: string; rect: CanvasNode } | null>(null);
  const flushNodeLive = useCallback(() => {
    const n = nodeLive.current;
    if (!n) return;
    setNodeOverrides((o) => ({ ...o, [n.id]: n.rect }));
  }, []);

  const onNodeRect = useCallback(
    (id: string, rect: CanvasNode, phase: RectPhase) => {
      if (phase === "live") {
        nodeLive.current = { id, rect };
        scheduleFrame("node", flushNodeLive);
        return;
      }
      // The cancel prevents a late flush from resurrecting the override we
      // just deleted.
      cancelFrame("node");
      nodeLive.current = null;
      setNodeOverrides((o) => {
        const next = { ...o };
        delete next[id];
        return next;
      });
      if (phase === "commit") {
        commit((c) => ({ ...c, nodes: { ...c.nodes, [id]: rect } }));
      }
    },
    [cancelFrame, commit, flushNodeLive, scheduleFrame],
  );

  const registerHandle = useCallback((id: string, h: XTermHandle | null) => {
    handlesRef.current[id] = h;
  }, []);

  const patchPortal = useCallback(
    (id: string, patch: Partial<Extract<CanvasItem, { type: "portal" }>>) => {
      commit((c) => patchItemOfType(c, id, "portal", patch));
    },
    [commit],
  );

  const portalBoundsQ = useRef(
    new Map<string, { x: number; y: number; w: number; h: number; visible: boolean }>(),
  );
  const flushPortalBounds = useCallback(() => {
    const q = portalBoundsQ.current;
    if (q.size === 0) return;
    const entries = [...q.entries()];
    q.clear();
    for (const [id, b] of entries) {
      void ipc.portalSetBounds(id, b.x, b.y, b.w, b.h, b.visible).catch(() => {});
    }
  }, []);
  const onPortalBounds = useCallback(
    (id: string, box: { x: number; y: number; w: number; h: number; visible: boolean }) => {
      portalBoundsQ.current.set(id, box);
      scheduleFrame("portal-bounds", flushPortalBounds);
    },
    [flushPortalBounds, scheduleFrame],
  );

  /**
   * Same two-channel preview as the note: size through `noteResize`, the
   * north/west offset through `itemDragDelta`. The card reports its rectangle
   * in world coordinates, so the delta is measured against what is persisted.
   */
  const onPortalRect = useCallback(
    (
      id: string,
      rect: { x: number; y: number; w: number; h: number },
      phase: RectPhase,
    ) => {
      const src = currentData().items.find((i) => i.id === id);
      const base = src?.type === "portal" ? src : null;
      if (phase === "live") {
        setNoteResize({ id, w: rect.w, h: rect.h });
        if (base) {
          const dx = rect.x - base.x;
          const dy = rect.y - base.y;
          setItemDragDelta(dx || dy ? { id, dx, dy } : null);
        }
        return;
      }
      setNoteResize(null);
      setItemDragDelta(null);
      if (phase === "commit") {
        commit((c) => patchItemOfType(c, id, "portal", { ...rect }));
      }
    },
    [commit, currentData],
  );

  const onRole = useCallback(
    (id: string, role: string) => {
      commit((c) => ({ ...c, roles: setEntry(c.roles, id, role) }));
    },
    [commit],
  );

  /**
   * Writes one field of a card's entry in `nodes`.
   *
   * The terminal may still be in an automatic position (nothing in `nodes`
   * yet), so the current rectangle goes in with it — otherwise picking a color
   * would snap the card back to its computed slot. `undefined` drops the
   * field, which is how "back to the default" is spelled.
   */
  const patchNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      const r = rectsRef.current[id];
      if (!r) return;
      commit((c) => {
        const prev = c.nodes[id] ?? r;
        const merged = { ...prev, ...patch };
        const next: CanvasNode = { x: r.x, y: r.y, w: r.w, h: r.h };
        // Rebuilt field by field so an explicit `undefined` really removes the
        // key instead of persisting as `"color": null` in the workspace JSON.
        if (merged.color) next.color = merged.color;
        if (merged.fontSize != null) next.fontSize = merged.fontSize;
        return { ...c, nodes: { ...c.nodes, [id]: next } };
      });
    },
    [commit],
  );

  const onNodeColor = useCallback(
    (id: string, colorPick?: string) => patchNode(id, { color: colorPick }),
    [patchNode],
  );

  const onNodeFontSize = useCallback(
    (id: string, px?: number) => patchNode(id, { fontSize: px }),
    [patchNode],
  );

  // --- context menu (right-click on anything on the canvas) ---

  const patchItem = (id: string, fn: (it: CanvasItem) => CanvasItem) => {
    commit((c) => patchItemById(c, id, fn));
  };

  const deleteItem = (id: string) => {
    const it = currentData().items.find((i) => i.id === id);
    if (it?.type === "portal") void ipc.portalClose(id).catch(() => {});
    commit((c) => removeItemAndEdges(c, id));
    setSelection((cur) => (cur === id ? null : cur));
  };

  const duplicateItem = (id: string) => {
    const src = currentData().items.find((i) => i.id === id);
    if (!src || src.type === "connection") return;
    const copy = { ...translateItem(src, 24, 24), id: nanoid(8) };
    commit((c) => {
      const idx = c.items.findIndex((i) => i.id === id);
      const next = [...c.items];
      next.splice(idx < 0 ? next.length : idx + 1, 0, copy);
      return { ...c, items: next };
    });
    setSelection(copy.id);
  };

  const reorderItem = (id: string, dir: "front" | "back") => {
    commit((c) => reorder(c, id, dir));
  };

  const onContainerContextMenu = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    // Never let the host WebView2 show "Inspecionar / Copiar imagem" on
    // the canvas. Cards and notes open the Yard menu; inputs keep paste.
    if (t.closest("textarea, input")) return;
    e.preventDefault();
    if (t.closest(".cv-card, .cv-toolbar, .cv-zoomctl, .menu")) return;
    const w = toWorld(e.clientX, e.clientY);
    // Same hit-test as the eraser: finds the top item under the click, which
    // also makes the menu work with a drawing tool active (the
    // overlay lets the contextmenu bubble up here).
    const tol = 6 / vpRef.current.zoom;
    const its = currentData().items;
    let hitId: string | null = null;
    for (let i = its.length - 1; i >= 0; i--) {
      if (hitItem(its[i], w.x, w.y, tol, (id) => anchorsRef.current[id])) {
        hitId = its[i].id;
        break;
      }
    }
    if (hitId) setSelection(hitId);
    setCtxMenu({ anchor: { x: e.clientX, y: e.clientY }, itemId: hitId, world: w });
  };

  /** Menu entries according to the target: each type has its own customization. */
  const ctxMenuItems = (): MenuEntry[] => {
    if (!ctxMenu) return [];
    const it = ctxMenu.itemId
      ? items.find((i) => i.id === ctxMenu.itemId)
      : undefined;

    // Canvas background: create things here and frame the camera.
    if (!it) {
      const w = ctxMenu.world;
      return [
        {
          id: "add",
          label: "Adicionar",
          icon: <Plus size={13} />,
          submenu: [
            {
              id: "cli",
              label: "Terminal",
              icon: <TerminalIcon size={13} />,
              shortcut: "Ctrl+T",
              onSelect: () => openModal("new-terminal", { groupId }),
            },
            {
              id: "note",
              label: "Nota",
              icon: <StickyNote size={13} />,
              onSelect: () => {
                const id = nanoid(8);
                commit((c) =>
                  addItems(c, {
                    id,
                    type: "note",
                    x: w.x,
                    y: w.y,
                    w: 230,
                    h: 170,
                    text: "",
                    color,
                  }),
                );
                setTool("select");
                setSelection(id);
                setEditingId(id);
              },
            },
            {
              id: "portal",
              label: "Portal",
              icon: <Globe size={13} />,
              shortcut: "W",
              onSelect: () => openModal("new-portal", { groupId, x: w.x, y: w.y }),
            },
            {
              id: "text",
              label: "Texto",
              icon: <Type size={13} />,
              onSelect: () => {
                const id = nanoid(8);
                commit((c) =>
                  addItems(c, {
                    id,
                    type: "text",
                    x: w.x,
                    y: w.y,
                    text: "",
                    fontSize: TEXT_PX[size],
                    color,
                  }),
                );
                setTool("select");
                setSelection(id);
                setEditingId(id);
              },
            },
          ],
        },
        { kind: "sep" },
        {
          id: "fit",
          label: "Enquadrar tudo",
          icon: <Expand size={13} />,
          onSelect: fitView,
        },
        {
          id: "zoom100",
          label: "Zoom 100%",
          icon: <Maximize2 size={13} />,
          onSelect: zoomTo100,
        },
      ];
    }

    const swatches: MenuSwatches = {
      kind: "swatches",
      colors: CANVAS_COLORS,
      active: it.color,
      onPick: (c) => patchItem(it.id, (i) => ({ ...i, color: c })),
    };
    const del: MenuEntry = {
      id: "delete",
      label: "Excluir",
      icon: <Trash2 size={13} />,
      danger: true,
      shortcut: "Del",
      onSelect: () => deleteItem(it.id),
    };
    const dup: MenuEntry = {
      id: "dup",
      label: "Duplicar",
      icon: <Copy size={13} />,
      onSelect: () => duplicateItem(it.id),
    };
    const order: MenuEntry[] = [
      {
        id: "front",
        label: "Trazer para a frente",
        icon: <BringToFront size={13} />,
        onSelect: () => reorderItem(it.id, "front"),
      },
      {
        id: "back",
        label: "Enviar para trás",
        icon: <SendToBack size={13} />,
        onSelect: () => reorderItem(it.id, "back"),
      },
    ];

    switch (it.type) {
      case "note":
        return [
          // The note is the one item with two surfaces to color, so here — and
          // only here — the swatch rows are captioned. Both offer the same
          // palette: the note is a single object, and a strip whose tones do
          // not exist on the block reads as two things glued together.
          { ...swatches, label: "Faixa" },
          {
            kind: "swatches",
            label: "Fundo",
            colors: CANVAS_COLORS,
            active: it.fill,
            onPick: (c) =>
              patchItem(it.id, (i) => (i.type === "note" ? { ...i, fill: c } : i)),
            onClear: () =>
              patchItem(it.id, (i) =>
                i.type === "note" ? { ...i, fill: undefined } : i,
              ),
          },
          { kind: "sep" },
          {
            id: "edit",
            label: "Editar nota",
            icon: <Pencil size={13} />,
            onSelect: () => {
              setSelection(it.id);
              beginTextEdit(it.id);
            },
          },
          {
            id: "lock",
            label: it.locked ? "Destravar para agentes" : "Travar contra agentes",
            icon: it.locked ? <Unlock size={13} /> : <Lock size={13} />,
            onSelect: () => toggleLock(it.id),
          },
          dup,
          { kind: "sep" },
          ...order,
          { kind: "sep" },
          del,
        ];
      case "text":
        return [
          swatches,
          {
            kind: "sizes",
            options: MENU_FONTS,
            active: (Object.keys(TEXT_PX) as StrokeSize[]).find(
              (k) => TEXT_PX[k] === it.fontSize,
            ),
            onPick: (s) =>
              patchItem(it.id, (i) =>
                i.type === "text" ? { ...i, fontSize: TEXT_PX[s as StrokeSize] } : i,
              ),
          },
          { kind: "sep" },
          {
            id: "edit",
            label: "Editar texto",
            icon: <Pencil size={13} />,
            onSelect: () => {
              setSelection(it.id);
              beginTextEdit(it.id);
            },
          },
          dup,
          { kind: "sep" },
          ...order,
          { kind: "sep" },
          del,
        ];
      case "portal":
        return [
          swatches,
          { kind: "sep" },
          {
            id: "mute",
            label: it.muted ? "Ativar som" : "Silenciar",
            onSelect: () =>
              patchItem(it.id, (i) =>
                i.type === "portal" ? { ...i, muted: !i.muted } : i,
              ),
          },
          dup,
          { kind: "sep" },
          ...order,
          { kind: "sep" },
          del,
        ];
      case "connection":
        return [
          swatches,
          { kind: "sep" },
          {
            id: "flip",
            label: "Inverter direção",
            icon: <ArrowLeftRight size={13} />,
            onSelect: () =>
              patchItem(it.id, (i) =>
                i.type === "connection" ? { ...i, from: i.to, to: i.from } : i,
              ),
          },
          del,
        ];
      // stroke, rect, ellipse, line, arrow
      default:
        return [
          swatches,
          {
            kind: "sizes",
            options: MENU_STROKES,
            active: it.size,
            onPick: (s) =>
              patchItem(it.id, (i) =>
                "size" in i ? { ...i, size: s as StrokeSize } : i,
              ),
          },
          { kind: "sep" },
          dup,
          ...order,
          { kind: "sep" },
          del,
        ];
    }
  };

  // --- render derivatives ---

  const z = vp.zoom;

  const draftItem: CanvasItem | null = useMemo(() => {
    if (!draft) return null;
    if (draft.kind === "stroke") {
      return { id: "__draft", type: "stroke", points: draft.points, size, color };
    }
    const { type, x1, y1, x2, y2 } = draft;
    if (type === "line" || type === "arrow") {
      return { id: "__draft", type, x1, y1, x2, y2, size, color, seed: draftSeed.current };
    }
    return {
      id: "__draft",
      type,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
      size,
      color,
      seed: draftSeed.current,
    };
  }, [draft, size, color]);

  const pendingConnect =
    connectFrom && cursorWorld && anchors[connectFrom]
      ? { from: anchors[connectFrom], to: cursorWorld }
      : null;

  const shiftOf = (id: string) =>
    itemDragDelta && itemDragDelta.id === id ? itemDragDelta : { dx: 0, dy: 0 };

  // How many active routines each card carries (clock badge in the header).
  const routineCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of data.routines ?? []) {
      if (r.enabled) m[r.terminalId] = (m[r.terminalId] ?? 0) + 1;
    }
    return m;
  }, [data.routines]);

  const [cardMenuOpen, setCardMenuOpen] = useState(false);
  const [zoomMenu, setZoomMenu] = useState<MenuAnchor | null>(null);
  // Anything floating over the canvas has to push the portals' native
  // surfaces out of the way: they are OS windows on top of the DOM, and a menu
  // underneath one is a menu nobody can read or click.
  const overlayActive =
    DRAW_TOOLS.includes(tool) || !!modalOpen || !!ctxMenu || !!zoomMenu || cardMenuOpen;

  // Memoized because these run on the pan path: `items` only changes on a
  // commit, but this component re-renders on every frame of a camera move.
  const domItems = useMemo(
    () =>
      items.filter(
        (i): i is Extract<CanvasItem, { type: "text" | "note" }> =>
          i.type === "text" || i.type === "note",
      ),
    [items],
  );
  const portalItems = useMemo(
    () =>
      items.filter(
        (i): i is Extract<CanvasItem, { type: "portal" }> => i.type === "portal",
      ),
    [items],
  );

  const empty = sorted.length === 0 && items.length === 0;

  return (
    <div
      ref={containerRef}
      // `cv--far`: zoomed out this much, no terminal is readable and the only
      // thing anyone is doing is arranging the board — so the whole card
      // becomes a drag handle instead of just its 30px header, which at this
      // scale is a seven-pixel target.
      className={`cv cv--${tool} ${spaceHeld ? "cv--space" : ""} ${
        panning ? "is-panning" : ""
      } ${z < 0.45 ? "cv--far" : ""}`}
      onPointerDown={onContainerPointerDown}
      onPointerMove={onContainerPointerMove}
      onPointerUp={onContainerPointerUp}
      onContextMenu={onContainerContextMenu}
    >
      <div
        className="cv-bg"
        style={{
          backgroundSize: `${GRID * z}px ${GRID * z}px`,
          backgroundPosition: `${(-vp.x * z) % (GRID * z)}px ${(-vp.y * z) % (GRID * z)}px`,
        }}
      />

      {/* Wiring under the cards and notes — needs to come before them in the
          DOM so the z-index tie with .cv-note/.cv-text resolves in their
          favor (see .cv-svg--under in styles.css). */}
      <ConnectionsLayer
        items={items}
        rects={anchors}
        vp={vp}
        selection={selection}
        pendingConnect={pendingConnect}
        onItemDown={onItemDown}
        onItemMove={onItemMove}
        onItemUp={onItemUp}
      />

      <div
        className="cv-world"
        // `--cv-z` is what lets the resize grips divide their thickness by the
        // zoom: inside a scaled world, a fixed 8px band becomes 2px of screen
        // at 25% and nobody can hit it.
        style={
          {
            transform: `translate(${-vp.x * z}px, ${-vp.y * z}px) scale(${z})`,
            "--cv-z": z,
          } as React.CSSProperties
        }
      >
        {domItems.map((raw) => {
          const { dx, dy } = shiftOf(raw.id);
          const faded = pendingErase.has(raw.id);
          const isSel = selection === raw.id;
          if (raw.type === "text") {
            return (
              <TextItem
                key={raw.id}
                it={raw}
                dx={dx}
                dy={dy}
                selected={isSel}
                faded={faded}
                editing={editingId === raw.id}
                onItemDown={onItemDown}
                onItemMove={onItemMove}
                onItemUp={onItemUp}
                onBeginEdit={beginTextEdit}
                onPatchText={patchText}
                onEndEdit={endTextEdit}
              />
            );
          }
          const connectClass =
            tool === "connect" && connectFrom === raw.id
              ? "is-connect-source"
              : tool === "connect" && hoverNode === raw.id && connectFrom
                ? "is-connect-target"
                : "";
          return (
            <NoteItem
              key={raw.id}
              it={raw}
              dx={dx}
              dy={dy}
              w={noteResize?.id === raw.id ? noteResize.w : raw.w}
              h={noteResize?.id === raw.id ? noteResize.h : raw.h}
              selected={isSel}
              faded={faded}
              editing={editingId === raw.id}
              connectClass={connectClass}
              selectTool={tool === "select"}
              onItemDown={onItemDown}
              onItemMove={onItemMove}
              onItemUp={onItemUp}
              onSelect={selectItem}
              onBeginEdit={beginTextEdit}
              onPatchText={patchText}
              onEndEdit={endTextEdit}
              onToggleLock={toggleLock}
              focusAtEnd={focusAtEnd}
              onResizeStart={startNoteResize}
              onResizeMove={moveNoteResize}
              onResizeEnd={endNoteResize}
            />
          );
        })}

        {portalItems.map((raw) => {
          const { dx, dy } = shiftOf(raw.id);
          const connectClass =
            tool === "connect" && connectFrom === raw.id
              ? "is-connect-source"
              : tool === "connect" && hoverNode === raw.id && connectFrom
                ? "is-connect-target"
                : "";
          return (
            <PortalCard
              key={raw.id}
              it={raw}
              dx={dx}
              dy={dy}
              w={noteResize?.id === raw.id ? noteResize.w : raw.w}
              h={noteResize?.id === raw.id ? noteResize.h : raw.h}
              selected={selection === raw.id}
              faded={pendingErase.has(raw.id)}
              connectClass={connectClass}
              getZoom={getZoom}
              vp={vp}
              overlayActive={overlayActive}
              projectId={projectId}
              onSelect={selectItem}
              onItemDown={onItemDown}
              onItemMove={onItemMove}
              onItemUp={onItemUp}
              onPatch={patchPortal}
              onDelete={deleteItem}
              onFocus={focusNode}
              onMenuOpen={setCardMenuOpen}
              onRect={onPortalRect}
              onBounds={onPortalBounds}
            />
          );
        })}

        {sorted.map((t) => (
          <TerminalCard
            key={t.id}
            term={t}
            rect={rects[t.id]}
            getZoom={getZoom}
            focused={focusedTerminalId === t.id}
            role={data.roles?.[t.id]}
            onRole={onRole}
            routineCount={routineCounts[t.id] ?? 0}
            connectRole={
              tool === "connect"
                ? connectFrom === t.id
                  ? "source"
                  : hoverNode === t.id && connectFrom
                    ? "target"
                    : null
                : null
            }
            onRect={onNodeRect}
            onColor={onNodeColor}
            onFontSize={onNodeFontSize}
            onFocusZoom={focusNode}
            onMenuOpen={setCardMenuOpen}
            registerHandle={registerHandle}
          />
        ))}
      </div>

      <ItemsLayer
        items={items}
        vp={vp}
        selection={selection}
        fading={pendingErase}
        dragDelta={itemDragDelta}
        draft={draftItem}
        onItemDown={onItemDown}
        onItemMove={onItemMove}
        onItemUp={onItemUp}
      />

      {overlayActive && (
        <div
          className="cv-overlay"
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onOverlayPointerMove}
          onPointerUp={onOverlayPointerUp}
        />
      )}

      {empty && (
        <div className="cv-hint">
          <p>Canvas vazio.</p>
          <p>
            <kbd>Ctrl</kbd> + <kbd>T</kbd> abre um terminal; <kbd>W</kbd> um
            portal (navegador). Caneta, notas e formas ficam na barra à esquerda.
          </p>
          <p>
            Clique com o botão direito em qualquer ponto vazio para criar coisas
            aqui mesmo.
          </p>
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          anchor={ctxMenu.anchor}
          items={ctxMenuItems()}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {zoomMenu && (
        <ContextMenu
          anchor={zoomMenu}
          items={[
            {
              id: "fit",
              label: "Enquadrar tudo",
              icon: <Expand size={13} />,
              shortcut: "Shift+1",
              onSelect: fitView,
            },
            { kind: "sep" },
            ...[0.5, 1, 1.5, 2].map((factor) => ({
              id: `z${factor}`,
              label: `${factor * 100}%`,
              shortcut: factor === 1 ? "Ctrl+0" : undefined,
              onSelect: () => zoomToLevel(factor),
            })),
          ]}
          onClose={() => setZoomMenu(null)}
        />
      )}

      {tool === "connect" && (
        <div className="cv-status">
          {connectFrom
            ? "Clique no destino — terminal, nota ou portal (Esc cancela)"
            : "Clique na origem — terminal, nota ou portal. Ligado, o agente dirige o site (`yard portal`)."}
        </div>
      )}

      <CanvasToolbar
        tool={tool}
        onTool={(t) => {
          setTool(t);
          setConnectFrom(null);
          clearDraft();
        }}
        color={color}
        onColor={setColor}
        size={size}
        onSize={setSize}
        canUndo={undoRef.current.length > 0}
        canRedo={redoRef.current.length > 0}
        onUndo={undo}
        onRedo={redo}
      />

      <div className="cv-zoomctl">
        <button
          className="icon-btn"
          data-tip-side="top" data-tip="Afastar"
          aria-label="Afastar"
          onClick={() => zoomBy(1 / 1.25)}
        >
          <ZoomOut size={13} />
        </button>
        <button
          className="cv-zoom-pct"
          data-tip-side="top" data-tip-wrap="" data-tip="Voltar a 100% — o zoom em que o terminal é nítido. Botão direito: mais opções."
          aria-haspopup="menu"
          onClick={zoomTo100}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setZoomMenu({ x: r.left, y: r.top - 8 });
          }}
        >
          {Math.round(z * 100)}%
        </button>
        <button
          className="icon-btn"
          data-tip-side="top" data-tip="Aproximar"
          aria-label="Aproximar"
          onClick={() => zoomBy(1.25)}
        >
          <ZoomIn size={13} />
        </button>
        <button
          className="icon-btn"
          data-tip-side="top" data-tip="Enquadrar tudo"
          aria-label="Enquadrar tudo"
          onClick={fitView}
        >
          <Expand size={13} />
        </button>
      </div>
    </div>
  );
}
