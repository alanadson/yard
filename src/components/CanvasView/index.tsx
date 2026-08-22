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
import "./canvas.css";
import "./canvas-tail.css";
import { nanoid } from "nanoid";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowLeftRight,
  BringToFront,
  ClipboardPaste,
  Copy,
  Expand,
  Globe,
  LayoutGrid,
  Lock,
  Map as MapIcon,
  Maximize2,
  Pencil,
  Plus,
  Scissors,
  ScanSearch,
  SendToBack,
  SquareDashedMousePointer,
  StickyNote,
  Terminal as TerminalIcon,
  Trash2,
  Type,
  Unlock,
  Workflow,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { CanvasToolbar, type Tool } from "./CanvasToolbar";
import { FlowCard } from "./FlowCard";
import { FlowHud } from "./FlowHud";
import { Minimap, type MiniBox } from "./Minimap";
import { NoteToolbar, type NoteEditorApi } from "./NoteToolbar";
import { SelectionBar } from "./SelectionBar";
import { SelectionLayer } from "./SelectionLayer";
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
import { useEditor } from "../../stores/editorStore";
import { useFlows } from "../../stores/flowStore";
import { useLive } from "../../stores/liveStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { ipc, on, type PortalPlace, type TerminalRow } from "../../lib/ipc";
import { PortalBoundsQueue } from "../../lib/portalBoundsQueue";
import { useOccluder } from "../../hooks/useOccluder";
import { copyText, readClipboardText } from "../../lib/clipboard";
import { registerDropCamera } from "../../lib/dropPoint";
import { toggleTaskLine } from "../../lib/mdedit";
import { hostnameOf } from "../../lib/portals";
import { retainLivePortals } from "../../lib/portalSpawn";
import { baseName } from "../../lib/terminals";
import { readInitialPrefs } from "../../lib/prefs";
import { tabAction, selectionAnnouncement, itemName, escStep } from "../../lib/canvasKeys";
import {
  alignBoxes,
  boxesIntersect,
  distributeBoxes,
  snapMove,
  snapResize,
  tidyBoxes,
  unionBox,
  TIDY_ORDER,
  type AlignKind,
  type DistributeKind,
  type Moves,
  type SnapGuide,
  type TidyLayout,
} from "../../lib/arrange";
import {
  addItems,
  connection,
  patchItem as patchItemById,
  patchItemOfType,
  removeItemAndEdges,
  reorderItem as reorder,
} from "../../lib/canvasOps";
import { flowsOf, wireOfPair, type FlowItem } from "../../lib/flow";
import { cancelRunsOf, liveRunsOf } from "../../lib/flowRun";
import {
  autoNodeRect,
  clamp,
  CANVAS_COLORS,
  CANVAS_EXTERNAL_WRITE,
  EMPTY_CANVAS,
  FLOW_DEFAULT_W,
  FLOW_MIN_H,
  FLOW_MIN_W,
  flowCardHeight,
  hitItem,
  itemBounds,
  NODE_MIN_H,
  NODE_MIN_W,
  NOTE_FONT_DEFAULT,
  NOTE_FONT_MAX,
  NOTE_FONT_MIN,
  NOTE_MIN_H,
  NOTE_MIN_W,
  PORTAL_DEFAULT_H,
  PORTAL_DEFAULT_W,
  PORTAL_MIN_H,
  PORTAL_MIN_W,
  reconcileItems,
  reconcileNodes,
  resizeRect,
  stepFont,
  TEXT_FONT_DEFAULT,
  TEXT_FONT_MAX,
  TEXT_FONT_MIN,
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
  "flow",
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

/** One shared empty set: `new Set()` per render would break every memo below. */
const EMPTY_SEL: ReadonlySet<string> = new Set();

/**
 * Magnetism radius, in **screen** px. It is divided by the zoom before being
 * handed to `snapMove`: sticking is a "close enough to the eye" idea, so
 * zoomed out to 30% it has to cover three times as many world units or the
 * guides stop appearing exactly when the board is too small to aim at.
 */
const SNAP_TOL = 7;

/** Prefix of the JSON the canvas puts on the system clipboard. */
const CLIP_TAG = "yard/canvas-items@1";

/**
 * In-process fallback for copy/paste.
 *
 * The clipboard is the right channel — it survives across groups, workspaces
 * and app windows — but WebView2 can refuse `readText` outright (see
 * `lib/clipboard.ts`), and a Ctrl+V that silently does nothing is worse than
 * a paste that only works inside this session. Module scope, not a ref: the
 * point is to survive switching group, which unmounts this component.
 */
let clipFallback: CanvasItem[] = [];

const PREF_MINIMAP = "canvas.minimap";

export function CanvasView({ groupId, terminals, canvas }: Props) {
  const updateCanvas = useProjects((s) => s.updateCanvas);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const openModal = useUI((s) => s.openModal);
  const modalOpen = useUI((s) => s.modal);
  // Full-screen surfaces the app can open over the canvas — see
  // `portalsHidden` below.
  const composerOpen = useUI((s) => s.composerOpen);
  const liveOpen = useLive((s) => s.phase !== "closed");
  const diffOpen = useChanges((s) => s.viewer !== null);
  const editorOpen = useEditor((s) => s.open);
  const projectId = useProjects((s) => s.groups.find((g) => g.id === groupId)?.projectId ?? null);

  const data = canvas ?? EMPTY_CANVAS;

  // --- session state (none of this persists) ---
  const [vp, setVp] = useState<CanvasViewport>(
    () => canvas?.viewport ?? { ...EMPTY_CANVAS.viewport },
  );
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<string>(CANVAS_COLORS[0]);
  const [size, setSize] = useState<StrokeSize>("m");
  /**
   * Everything selected, cards and items in the same set.
   *
   * A card lives in `nodes` and a note in `items`, but "what is selected" is
   * one idea: align, tidy, nudge and delete all have to treat a terminal and
   * the note pinned beside it as members of the same group. Keeping two
   * selection states would mean writing every one of those operations twice.
   */
  const [selection, setSelection] = useState<ReadonlySet<string>>(EMPTY_SEL);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [cursorWorld, setCursorWorld] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingErase, setPendingErase] = useState<Set<string>>(() => new Set());
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, CanvasNode>>({});
  /** Rubber band in world coordinates, alive only while the pointer is down. */
  const [marquee, setMarquee] = useState<Box | null>(null);
  /** Magnetic guides of the gesture in progress. */
  const [guides, setGuides] = useState<readonly SnapGuide[]>([]);
  const [minimap, setMinimap] = useState(false);
  /** Size of the canvas viewport in screen px — the minimap needs it to draw
      the camera rectangle, and it is the only thing here that reads it. */
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  /**
   * Live offset of the items being dragged. A set, not an id: dragging one
   * member of a selection has to carry the other five along, and the
   * anchors/notes/vector layers all read the offset from here.
   */
  const [itemDragDelta, setItemDragDelta] = useState<{
    ids: ReadonlySet<string>;
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
  /**
   * The drag of a selection started from an item.
   *
   * `ids` is the whole moving set (items *and* cards), frozen at pointerdown:
   * recomputing it from `selection` per frame would let a stray click midway
   * change what is under the hand. `bases` are the rectangles it started from,
   * which is what the snap and the final commit measure against.
   */
  const itemSess = useRef<{
    pointerId: number;
    ids: string[];
    /** The same ids as a set, built once: `flushItemDrag` runs every frame. */
    idSet: ReadonlySet<string>;
    sx: number;
    sy: number;
    bases: Record<string, Box>;
    union: Box;
  } | null>(null);
  /** Rubber band in progress: origin in world, plus the selection it adds to. */
  const marqueeSess = useRef<{
    pointerId: number;
    ox: number;
    oy: number;
    base: ReadonlySet<string>;
  } | null>(null);
  /**
   * Last pointer position, in **client** px. Paste means "where the mouse is"
   * and a key event carries no coordinates of its own.
   *
   * Client and not world on purpose: this is written on every pointermove over
   * the canvas, and converting there would put a `getBoundingClientRect` on
   * the one path this file spends its whole architecture keeping cheap. The
   * conversion happens once, when a key actually asks.
   */
  const cursorClientRef = useRef<{ x: number; y: number } | null>(null);
  /** Rotating cursors for the two "take me to the next one" shortcuts. */
  const wireStep = useRef(0);
  const wirePrev = useRef<string | null>(null);
  /** Magnetism suppressed for the gesture in progress (Ctrl held on the press). */
  const dragFree = useRef(false);
  /** Resting rectangles of the set a card gesture moves, frozen at frame one. */
  const dragBases = useRef<Record<string, Box>>({});
  const dragUnion = useRef<Box | null>(null);
  const noteSess = useRef<{
    id: string;
    pointerId: number;
    dir: ResizeDir;
    cx: number;
    cy: number;
    start: Box;
    /** Floor of the item being pulled — note and flow card have their own minimums. */
    minW: number;
    minH: number;
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
      // Zeroing is not cosmetic: `scheduleFrame` uses this handle as "there is
      // already a frame coming". Leaving the cancelled id here makes every
      // future call short-circuit and the queue never flushes again — the
      // whole canvas (pan, drag, portal bounds) freezes silently. Reachable in
      // dev, where a hot update re-runs this cleanup on a live component.
      frameRaf.current = 0;
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

  /**
   * Ticks when the canvas changes size or place on screen with no canvas
   * state moving: the sidebar or a panel opening, the window being resized.
   *
   * Only the portals care — their browser is an OS window placed in screen
   * coordinates — and nothing in their own props can tell them: same camera,
   * same rectangle in the world, different pixels on the monitor. Without
   * this the page stayed where it was while its card slid sideways.
   */
  const [layoutTick, setLayoutTick] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    const bump = () => {
      setLayoutTick((n) => n + 1);
      // Same observer, second reader: the minimap needs the viewport in screen
      // px to draw the camera rectangle, and a second ResizeObserver on the
      // same element would just double the callbacks.
      if (el) {
        setViewSize((s) =>
          s.w === el.clientWidth && s.h === el.clientHeight
            ? s
            : { w: el.clientWidth, h: el.clientHeight },
        );
      }
    };
    bump();
    window.addEventListener("resize", bump);
    const ro = new ResizeObserver(bump);
    if (el) ro.observe(el);
    return () => {
      window.removeEventListener("resize", bump);
      ro.disconnect();
    };
  }, []);

  /**
   * One place decides whether the gesture about to start is magnetic.
   *
   * Capture phase on the window, so it sees the press before every card,
   * note and resize grip — several of which call `stopPropagation` on their
   * way up and would otherwise each need to remember to pass the modifier
   * along. Ctrl held at the press turns the snapping off for that gesture.
   */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      dragFree.current = e.ctrlKey || e.metaKey;
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Whether the minimap is open is a habit, not a property of the workspace —
  // it belongs with the preferences, next to the sidebar and the bench.
  useEffect(() => {
    let alive = true;
    void readInitialPrefs()
      .then((p) => {
        if (alive && p[PREF_MINIMAP] === "true") setMinimap(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const sorted = useMemo(
    () => [...terminals].sort((a, b) => a.sort - b.sort),
    [terminals],
  );
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;

  // The canvas persists as JSON: each commit re-parses and would return new
  // objects for EVERYTHING, killing the children's memos. Reconciliation
  // returns the old references for what didn't change in content.
  const prevItemsRef = useRef<CanvasItem[]>([]);
  const items = useMemo(() => {
    const next = reconcileItems(prevItemsRef.current, data.items);
    prevItemsRef.current = next;
    return next;
  }, [data.items]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

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
    const anchored = items.some(
      (i) =>
        (i.type === "note" || i.type === "portal" || i.type === "flow") &&
        itemDragDelta.ids.has(i.id),
    );
    return anchored ? itemDragDelta : null;
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
      if (it.type !== "note" && it.type !== "portal" && it.type !== "flow") continue;
      const live = noteResize?.id === it.id ? noteResize : null;
      const shift = noteDrag?.ids.has(it.id) ? noteDrag : null;
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

  // --- selection geometry ---
  //
  // Everything selectable, as a plain rectangle: cards from `rects`, the rest
  // from `itemBounds`. Two memos and not one because they change at very
  // different rates — `rects` moves on every frame of a drag, while the item
  // boxes only change on a commit, and a stroke's bounds means walking all its
  // points. Merging them per frame would put that walk on the hot path.

  const itemBoxes = useMemo(() => {
    const m: Record<string, Box> = {};
    for (const it of items) {
      if (it.type === "connection") continue;
      const b = itemBounds(it, () => undefined);
      if (b) m[it.id] = b;
    }
    return m;
  }, [items]);
  const itemBoxesRef = useRef(itemBoxes);
  itemBoxesRef.current = itemBoxes;

  /** Resting rectangle of anything selectable — the live drag never shows here. */
  const boxOf = useCallback(
    (id: string): Box | undefined => rectsRef.current[id] ?? itemBoxesRef.current[id],
    [],
  );

  /** Every selectable id with its rectangle. Built on demand, at gesture time. */
  const allBoxes = useCallback((): Record<string, Box> => {
    return { ...itemBoxesRef.current, ...rectsRef.current };
  }, []);

  const boxesOf = useCallback(
    (ids: Iterable<string>): Record<string, Box> => {
      const m: Record<string, Box> = {};
      for (const id of ids) {
        const b = boxOf(id);
        if (b) m[id] = b;
      }
      return m;
    },
    [boxOf],
  );

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // The `Escape` chain consults the current tool without entering the
  // keyboard effect's dependencies — switching tools must not reinstall the
  // listener.
  const toolRef = useRef(tool);
  toolRef.current = tool;

  /**
   * The board's voice channel. The `Tab` cycle swaps the selection without
   * touching DOM focus, so this is how a screen reader learns that something
   * changed. The trailing space forces a DOM change when the text repeats —
   * without it, landing twice on the same item would not be re-announced.
   */
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((theText: string) => {
    setAnnouncement((currentValue) => (currentValue === theText ? `${theText} ` : theText));
  }, []);

  /** Replaces the selection with a single id (or clears it). */
  const selectOnly = useCallback((id: string | null) => {
    setSelection(id ? new Set([id]) : EMPTY_SEL);
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelection((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dropFromSelection = useCallback((id: string) => {
    setSelection((cur) => {
      if (!cur.has(id)) return cur;
      const next = new Set(cur);
      next.delete(id);
      return next.size ? next : EMPTY_SEL;
    });
  }, []);

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

  /**
   * Undo and redo swap the whole canvas, so a portal card can appear or
   * disappear without passing through the delete path that closes its engine.
   * Unmounting a `PortalCard` only hides the engine — deliberately, so leaving
   * canvas mode does not throw away a page being watched — which means an
   * undone portal used to leave a WebView2 running with no card behind it.
   * Reconciling against the backend registry afterwards is what collects it.
   */
  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(currentData());
    updateCanvas(groupId, () => ({ ...prev }));
    setSelection(EMPTY_SEL);
    bump();
    void retainLivePortals();
  }, [currentData, groupId, updateCanvas]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(currentData());
    updateCanvas(groupId, () => ({ ...next }));
    setSelection(EMPTY_SEL);
    bump();
    void retainLivePortals();
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

  /**
   * Publishes the camera so whatever is created from *outside* this component
   * still lands where the mouse is: the "+ Terminal" button lives in the title
   * bar and the palette floats over everything, so neither has a click on the
   * board of its own to hand to the creator (see `lib/dropPoint`).
   */
  useEffect(
    () =>
      registerDropCamera(groupId, () => {
        const el = containerRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const v = vpRef.current;
        const c = cursorClientRef.current;
        return {
          view: { x: v.x, y: v.y, w: r.width / v.zoom, h: r.height / v.zoom },
          cursor: c ? toWorld(c.x, c.y) : null,
        };
      }),
    [groupId, toWorld],
  );

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

  /** Brings the camera onto a world rectangle, centered, with room around it. */
  const frameBox = useCallback(
    (b: Box, pad = 60, maxZoom = 1.25) => {
      const el = containerRef.current;
      if (!el) return;
      const zoom = clamp(
        Math.min(el.clientWidth / (b.w + pad * 2), el.clientHeight / (b.h + pad * 2)),
        ZOOM_MIN,
        maxZoom,
      );
      setVp({
        zoom,
        x: b.x - (el.clientWidth / zoom - b.w) / 2,
        y: b.y - (el.clientHeight / zoom - b.h) / 2,
      });
      scheduleVpCommit();
    },
    [scheduleVpCommit],
  );

  /** Puts a world point in the middle of the screen without touching the zoom. */
  const centerOn = useCallback(
    (x: number, y: number) => {
      const el = containerRef.current;
      if (!el) return;
      setVp((v) => ({
        ...v,
        x: x - el.clientWidth / v.zoom / 2,
        y: y - el.clientHeight / v.zoom / 2,
      }));
      scheduleVpCommit();
    },
    [scheduleVpCommit],
  );

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
    frameBox({
      x: bx,
      y: by,
      w: Math.max(...boxes.map((b) => b.x + b.w)) - bx,
      h: Math.max(...boxes.map((b) => b.y + b.h)) - by,
    });
  }, [currentData, frameBox, scheduleVpCommit]);

  /**
   * Frames the selection (Shift+2), the twin of "enquadrar tudo".
   *
   * It goes past 1.25× on purpose — up to 2× — because framing *one* note is
   * a request to read it, and stopping at 1.25 would leave a 140px sticky
   * floating in the middle of an empty screen.
   */
  const fitSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.size === 0) return fitView();
    const u = unionBox(boxesOf(sel));
    if (u) frameBox(u, 80, 2);
  }, [boxesOf, fitView, frameBox]);

  // --- arrangement ---

  /**
   * Writes a batch of "this id belongs at (x, y)" in one commit.
   *
   * Cards and items take different roads — a card is a rectangle in `nodes`,
   * an item is moved by translating its own geometry — and the whole point of
   * this function is that everything above it (align, distribute, tidy, the
   * arrow keys) gets to speak in rectangles and never learn the difference.
   *
   * For items the target is compared against the *bounding box*, not against
   * `x`/`y`: a pen stroke has no origin field, and its bounds are the only
   * thing align was ever talking about.
   */
  const applyMoves = useCallback(
    (moves: Moves) => {
      const ids = Object.keys(moves);
      if (ids.length === 0) return;
      const rects = rectsRef.current;
      const boxes = itemBoxesRef.current;
      commit((c) => {
        const nodesNext = { ...c.nodes };
        for (const id of ids) {
          const r = rects[id];
          if (!r) continue;
          nodesNext[id] = { ...r, x: moves[id].x, y: moves[id].y };
        }
        return {
          ...c,
          nodes: nodesNext,
          items: c.items.map((it) => {
            const target = moves[it.id];
            const b = boxes[it.id];
            if (!target || !b) return it;
            return translateItem(it, target.x - b.x, target.y - b.y);
          }),
        };
      });
    },
    [commit],
  );

  const alignSelection = useCallback(
    (kind: AlignKind) => applyMoves(alignBoxes(boxesOf(selectionRef.current), kind)),
    [applyMoves, boxesOf],
  );

  const distributeSelection = useCallback(
    (kind: DistributeKind) =>
      applyMoves(distributeBoxes(boxesOf(selectionRef.current), kind)),
    [applyMoves, boxesOf],
  );

  /**
   * Tidy cycles layouts on repeated presses of Ctrl+Shift+T (grid, row,
   * column). The step resets whenever the selection changes: pressing it
   * on a fresh set of cards should give the grid, not whatever the last set
   * happened to leave behind.
   */
  const tidyStep = useRef(0);
  const tidyKey = useRef("");
  const tidySelection = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.size < 2) return;
    const key = [...sel].sort().join(",");
    if (key !== tidyKey.current) {
      tidyKey.current = key;
      tidyStep.current = 0;
    }
    const layout: TidyLayout = TIDY_ORDER[tidyStep.current % TIDY_ORDER.length];
    tidyStep.current += 1;
    applyMoves(tidyBoxes(boxesOf(sel), layout));
  }, [applyMoves, boxesOf]);

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
    const unsubs: Array<() => void> = [];
    const keep = (u: () => void) => {
      if (gone) u();
      else unsubs.push(u);
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
      unsubs.forEach((u) => u());
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
  const connectFromRef = useRef(connectFrom);
  connectFromRef.current = connectFrom;

  /**
   * Deletes everything selected in a single commit.
   *
   * Cards are left alone: a terminal is a live process, and Delete on the
   * canvas must never be the gesture that kills one. They are dropped from the
   * selection instead, so a marquee over the whole board followed by Delete
   * clears the drawings and leaves the agents running.
   */
  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.size === 0) return;
    const live = currentData().items;
    const dead = new Set(
      live.filter((i) => sel.has(i.id) && !rectsRef.current[i.id]).map((i) => i.id),
    );
    if (dead.size === 0) return;
    for (const it of live) {
      if (it.type === "portal" && dead.has(it.id)) {
        void ipc.portalClose(it.id).catch(() => {});
      }
    }
    // A flow card being deleted mid-run: the engine holds its own copy of the
    // pipeline, so without this it kept stamping the next stage into the CLI
    // from a card nobody could see any more.
    cancelRunsOf(dead);
    commit((c) => ({
      ...c,
      items: c.items.filter(
        (i) =>
          !dead.has(i.id) &&
          !(i.type === "connection" && (dead.has(i.from) || dead.has(i.to))),
      ),
    }));
    setSelection(EMPTY_SEL);
  }, [commit, currentData]);

  /**
   * Delete with a question when there is something to protect.
   *
   * `Ctrl+A` then `Delete` used to erase notes, drawings, portals and every
   * wire in the group in a single commit, with no confirmation anywhere in
   * this file — and closing a portal happens **before** the commit, so the
   * undo brings the card back without its history, its scroll or (with the
   * default `storage: "instance"`) its cookies. A single note still deletes
   * instantly: friction has to be proportional to what is at stake.
   */
  const deleteSelectionAsked = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.size === 0) return;
    const live = currentData().items;
    const targets = live.filter((i) => sel.has(i.id) && !rectsRef.current[i.id]);
    if (targets.length === 0) return;
    const portals = targets.filter((i) => i.type === "portal").length;
    // A running flow always deserves the question, even alone: deleting the
    // card stops a pipeline that is in the middle of a stage inside a CLI.
    const running = liveRunsOf(targets.map((i) => i.id));
    if (targets.length < 3 && portals === 0 && running.length === 0) {
      deleteSelection();
      return;
    }
    const parts = [`${targets.length} item(ns) do canvas`];
    if (portals > 0) {
      parts.push(
        `${portals} portal(is) — a sessão do navegador (histórico e cookies) não volta com o desfazer`,
      );
    }
    if (running.length > 0) {
      parts.push(
        `${running.length} fluxo(s) em execução (${running
          .map((r) => `"${r.name}"`)
          .join(", ")}) — a esteira é cancelada na etapa atual`,
      );
    }
    void ask(`Excluir ${parts.join("; ")}?`, {
      title: "Excluir seleção",
      kind: "warning",
    }).then((ok) => {
      if (ok) deleteSelection();
    });
  }, [currentData, deleteSelection]);

  /**
   * Copies of everything selected, offset and with fresh ids — plus the wires
   * *between* the copies, so duplicating an agent and its two notes brings
   * the little graph along instead of three loose rectangles.
   */
  const cloneItems = useCallback(
    (ids: ReadonlySet<string>, dx: number, dy: number, source?: CanvasItem[]) => {
      const live = source ?? currentData().items;
      const idMap = new Map<string, string>();
      for (const it of live) {
        if (it.type !== "connection" && ids.has(it.id)) idMap.set(it.id, nanoid(8));
      }
      const copies: CanvasItem[] = [];
      for (const it of live) {
        if (it.type === "connection") {
          const from = idMap.get(it.from);
          const to = idMap.get(it.to);
          if (from && to) copies.push({ ...it, id: nanoid(8), from, to });
          continue;
        }
        const fresh = idMap.get(it.id);
        if (fresh) copies.push({ ...translateItem(it, dx, dy), id: fresh });
      }
      return { copies, ids: new Set(idMap.values()) };
    },
    [currentData],
  );

  const duplicateSelection = useCallback(() => {
    const { copies, ids } = cloneItems(selectionRef.current, 24, 24);
    if (copies.length === 0) return;
    commit((c) => addItems(c, ...copies));
    setSelection(ids);
  }, [cloneItems, commit]);

  /**
   * Plants a flow card (a prompt pipeline) and opens the editor. The flow is
   * born empty and with no CLI at all — connecting a terminal to it (tool C)
   * is what arms it later.
   */
  const createFlowAt = useCallback(
    (at: { x: number; y: number }) => {
      const id = nanoid(8);
      commit((c) =>
        addItems(c, {
          id,
          type: "flow",
          x: at.x,
          y: at.y,
          w: FLOW_DEFAULT_W,
          h: flowCardHeight(0),
          name: `Fluxo ${flowsOf(c).length + 1}`,
          stages: [],
          color: CANVAS_COLORS[0],
        }),
      );
      setTool("select");
      selectOnly(id);
      openModal("flow", { groupId, itemId: id });
    },
    [commit, groupId, openModal, selectOnly],
  );

  const selectAll = useCallback(() => {
    setSelection(new Set(Object.keys(allBoxes())));
  }, [allBoxes]);

  /** Puts the selected items on the clipboard (cards can't travel). */
  const copySelection = useCallback(async () => {
    const sel = selectionRef.current;
    const chosen = currentData().items.filter(
      (i) =>
        !rectsRef.current[i.id] &&
        (sel.has(i.id) ||
          (i.type === "connection" && sel.has(i.from) && sel.has(i.to))),
    );
    if (chosen.length === 0) return false;
    clipFallback = chosen;
    await copyText(`${CLIP_TAG}\n${JSON.stringify(chosen)}`);
    return true;
  }, [currentData]);

  /**
   * Pastes at the cursor when there is one, at the middle of the screen
   * otherwise — the two places a person means by "here".
   */
  const pasteClipboard = useCallback(async () => {
    const raw = await readClipboardText();
    let source = clipFallback;
    if (raw?.startsWith(CLIP_TAG)) {
      try {
        const parsed = JSON.parse(raw.slice(CLIP_TAG.length));
        if (Array.isArray(parsed) && parsed.length) source = parsed as CanvasItem[];
      } catch {
        // Junk on the clipboard is not an error worth showing: fall back.
      }
    }
    if (source.length === 0) return;
    const el = containerRef.current;
    const v = vpRef.current;
    const c = cursorClientRef.current;
    const target = c
      ? toWorld(c.x, c.y)
      : {
          x: v.x + (el?.clientWidth ?? 0) / v.zoom / 2,
          y: v.y + (el?.clientHeight ?? 0) / v.zoom / 2,
        };
    const u = unionBox(
      Object.fromEntries(
        source
          .map((it) => [it.id, itemBounds(it, () => undefined)] as const)
          .filter((e): e is [string, Box] => !!e[1]),
      ),
    );
    const dx = u ? target.x - (u.x + u.w / 2) : 0;
    const dy = u ? target.y - (u.y + u.h / 2) : 0;
    const { copies, ids } = cloneItems(
      new Set(source.map((i) => i.id)),
      dx,
      dy,
      source,
    );
    if (copies.length === 0) return;
    commit((c) => addItems(c, ...copies));
    setSelection(ids);
  }, [cloneItems, commit, toWorld]);

  /**
   * Walks the wiring: from whatever is selected, hop to a neighbour and bring
   * the camera along. It is the keyboard answer to a board too big for one
   * screen — following a connection beats hunting for the other end by hand.
   */
  const walkWire = useCallback(
    (dir: 1 | -1) => {
      const sel = selectionRef.current;
      const from = sel.size === 1 ? [...sel][0] : null;
      const c = currentData();
      const neighbours: string[] = [];
      for (const it of c.items) {
        if (it.type !== "connection") continue;
        if (from && it.from === from) neighbours.push(it.to);
        else if (from && it.to === from) neighbours.push(it.from);
      }
      // Nothing selected (or a dead end): start from any wired element, so the
      // shortcut always does something instead of failing silently.
      const pool = neighbours.length
        ? neighbours
        : c.items.flatMap((i) => (i.type === "connection" ? [i.from] : []));
      if (pool.length === 0) return;
      let uniq = [...new Set(pool)].filter((id) => !!boxOf(id));
      // At a fork, don't offer the node we just came from: walking a chain
      // has to move forward, not bounce between two cards forever. At a dead
      // end it stays available — going back is the only way out.
      const back = uniq.filter((id) => id !== wirePrev.current);
      if (back.length) uniq = back;
      if (uniq.length === 0) return;
      const step = wireStep.current;
      wireStep.current = step + dir;
      const next = uniq[((step % uniq.length) + uniq.length) % uniq.length];
      wirePrev.current = from;
      selectOnly(next);
      const b = boxOf(next)!;
      centerOn(b.x + b.w / 2, b.y + b.h / 2);
    },
    [boxOf, centerOn, currentData, selectOnly],
  );

  /** Tab order across the whole board: cards first, then everything drawn. */
  const cycleElement = useCallback(
    (dir: 1 | -1) => {
      const cards = sortedRef.current;
      const drawn = itemsRef.current.filter((i) => i.type !== "connection");
      const ids = [...cards.map((t) => t.id), ...drawn.map((i) => i.id)];
      if (ids.length === 0) return;
      const sel = selectionRef.current;
      const cur = sel.size ? ids.findIndex((id) => sel.has(id)) : -1;
      const targetIndex = (((cur + dir) % ids.length) + ids.length) % ids.length;
      const next = ids[targetIndex];
      selectOnly(next);
      const b = boxOf(next);
      if (b) centerOn(b.x + b.w / 2, b.y + b.h / 2);
      // Selecting is not focusing: the border lights up and the camera moves,
      // but none of that reaches a screen reader on its own. The announcement
      // is the only channel.
      const card = cards[targetIndex];
      announce(
        card
          ? selectionAnnouncement({ kind: "terminal", name: baseName(card) }, targetIndex, ids.length)
          : selectionAnnouncement(
              { kind: "item", type: drawn[targetIndex - cards.length].type, name: itemName(drawn[targetIndex - cards.length]) },
              targetIndex,
              ids.length,
            ),
      );
    },
    [announce, boxOf, centerOn, selectOnly],
  );

  /**
   * "Take me to this thing" from the Search (`Ctrl+P`).
   *
   * It arrives through the store rather than as an event because the pick may
   * happen while *another* group is on screen: the request has to wait until
   * this canvas exists, and an effect is exactly that wait.
   */
  const reveal = useUI((s) => s.canvasReveal);
  useEffect(() => {
    if (!reveal || reveal.groupId !== groupId) return;
    const box = boxOf(reveal.id);
    useUI.getState().clearCanvasReveal();
    if (!box) {
      useUI.getState().showToast("Isso não está mais no canvas deste grupo.", "error");
      return;
    }
    selectOnly(reveal.id);
    centerOn(box.x + box.w / 2, box.y + box.h / 2);
  }, [reveal, groupId, boxOf, selectOnly, centerOn]);

  const toggleMinimap = useCallback(() => {
    setMinimap((v) => {
      void ipc.writePref(PREF_MINIMAP, String(!v)).catch(() => {});
      return !v;
    });
  }, []);

  useEffect(() => {
    /**
     * Arrow keys: 1px of world, 10 with Shift — the precision drag can't give.
     * Only the first key of a burst opens an undo entry; held down, the whole
     * slide collapses into one, instead of eating the 60-snapshot history.
     */
    const nudge = (dx: number, dy: number, repeat: boolean) => {
      const sel = selectionRef.current;
      if (sel.size === 0) return;
      const moves: Moves = {};
      for (const id of sel) {
        const b = boxOf(id);
        if (b) moves[id] = { x: b.x + dx, y: b.y + dy };
      }
      if (repeat) {
        // A held arrow must not push sixty snapshots: reuse the entry the
        // first press opened, exactly like the old single-item nudge did.
        const ids = Object.keys(moves);
        if (ids.length === 0) return;
        const rects = rectsRef.current;
        const boxes = itemBoxesRef.current;
        updateCanvas(groupId, (c) => {
          const nodesNext = { ...c.nodes };
          for (const id of ids) {
            const r = rects[id];
            if (r) nodesNext[id] = { ...r, x: moves[id].x, y: moves[id].y };
          }
          return {
            ...c,
            nodes: nodesNext,
            items: c.items.map((it) => {
              const target = moves[it.id];
              const b = boxes[it.id];
              return target && b ? translateItem(it, target.x - b.x, target.y - b.y) : it;
            }),
            viewport: { ...vpRef.current },
          };
        });
        return;
      }
      applyMoves(moves);
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // A surface on top of the canvas (modal, diff, editor) takes the whole
      // keyboard: Delete here would erase the item behind it.
      const blocked =
        !!useUI.getState().modal ||
        !!useChanges.getState().viewer ||
        useEditor.getState().open;

      // The minimap survives a terminal holding the keyboard: it is about
      // *finding* your way on the board, and having to click the background
      // first is exactly the friction it exists to remove. (Jumping to
      // whoever asks for attention lives in `hooks/useKeybindings`: it
      // applies in any layout, not only here.)
      if (!blocked && (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        toggleMinimap();
        return;
      }

      const typing =
        t.closest?.(".xterm") ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.isContentEditable;
      if (typing) {
        if (e.key === "Escape" && !t.closest(".xterm")) (t as HTMLElement).blur();
        return;
      }
      if (blocked) return;
      // ...and so does anything else on screen that holds focus. This listener
      // is on the window, and the check above only knew about *full-screen*
      // surfaces — so with focus on a row of the file tree (a `div`, not an
      // input) `Delete` deleted the selected note, and the single-letter tool
      // keys switched the canvas tool from the sidebar or the bench.
      //
      // "No focus at all" still counts as the canvas: `document.body` is where
      // focus sits right after mount, and before the first click the arrows
      // and tool keys are expected to work.
      const focus = document.activeElement;
      const noCanvas =
        !focus || focus === document.body || !!containerRef.current?.contains(focus);
      if (!noCanvas) return;
      // `Tab` is the only shortcut here that needs to know whether focus is
      // on the board *itself* or on a control inside it — see `acaoDoTab`.
      const boardFocus = {
        isBoard: !!containerRef.current && focus === containerRef.current,
        insideBoard: !!focus && !!containerRef.current?.contains(focus),
      };

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
      // Walking the wiring: Alt is what keeps this off Ctrl+arrow, which most
      // terminals send to the shell as a word-jump.
      if (ctrl && e.altKey && (e.code === "ArrowRight" || e.code === "ArrowLeft")) {
        e.preventDefault();
        walkWire(e.code === "ArrowRight" ? 1 : -1);
        return;
      }
      if (ctrl && !e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (ctrl && e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        tidySelection();
        return;
      }
      if (ctrl && !e.shiftKey && (e.code === "KeyC" || e.code === "KeyX")) {
        // No preventDefault before we know there is something to copy: with an
        // empty selection the browser's own copy of a text selection is the
        // right behaviour.
        const cutting = e.code === "KeyX";
        void copySelection().then((ok) => {
          if (ok && cutting) deleteSelection();
        });
        return;
      }
      if (ctrl && !e.shiftKey && e.code === "KeyV") {
        void pasteClipboard();
        return;
      }
      if (ctrl) return; // Ctrl+T and friends belong to the global shortcuts

      if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        fitView();
        return;
      }
      if (e.shiftKey && e.code === "Digit2") {
        e.preventDefault();
        fitSelection();
        return;
      }
      if (e.code === "Tab") {
        // With focus on a card button, or no focus at all, `Tab` belongs to
        // the browser: hijacking it there trapped the keyboard inside the
        // canvas forever, because the cycle swaps the selection without
        // moving DOM focus.
        if (tabAction(boardFocus) === "navega") return;
        e.preventDefault();
        cycleElement(e.shiftKey ? -1 : 1);
        return;
      }
      // Stroke width from the keyboard, the way every drawing app spells it.
      if (e.code === "BracketLeft" || e.code === "BracketRight") {
        e.preventDefault();
        const order: StrokeSize[] = ["s", "m", "l"];
        setSize((cur) => {
          const i = order.indexOf(cur) + (e.code === "BracketRight" ? 1 : -1);
          return order[clamp(i, 0, order.length - 1)];
        });
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
        if (selectionRef.current.size === 0) return;
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
        KeyF: "flow",
      };
      if (toolByKey[e.code]) {
        setTool(toolByKey[e.code]);
        setConnectFrom(null);
        return;
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        deleteSelectionAsked();
        return;
      }
      if (e.code === "Escape") {
        switch (
          escStep({
            strokeDraft: !!draftRef.current,
            connecting: !!connectFromRef.current,
            selectedCount: selectionRef.current.size,
            activeTool: toolRef.current,
          })
        ) {
          case "limpa-rascunho":
            clearDraft();
            break;
          case "cancela-conexao":
            setConnectFrom(null);
            break;
          case "limpa-selecao":
            setSelection(EMPTY_SEL);
            break;
          case "volta-para-selecionar":
            setTool("select");
            break;
          case "solta-o-tabuleiro":
            // The canvas's keyboard exit (WCAG 2.1.2): without this, whoever
            // gets here without a mouse is trapped — `Tab` belongs to the
            // board and nothing else hands focus back to the document.
            containerRef.current?.blur();
            break;
        }
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
  }, [
    applyMoves,
    boxOf,
    clearDraft,
    copySelection,
    cycleElement,
    deleteSelection,
    deleteSelectionAsked,
    duplicateSelection,
    fitSelection,
    fitView,
    groupId,
    pasteClipboard,
    redo,
    selectAll,
    tidySelection,
    toggleMinimap,
    undo,
    updateCanvas,
    walkWire,
    zoomBy,
    zoomTo100,
  ]);

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

  /**
   * Hands keyboard focus to the canvas itself.
   *
   * Both this component's pointer handlers call `preventDefault` (to start a
   * pan, to protect a textarea), which suppresses the browser's own focus
   * pass — so after clicking the background the focus stayed wherever it was,
   * often on a row of the file tree. Since the key handler now requires focus
   * to be inside the canvas, taking it explicitly is what keeps the shortcuts
   * working. The container carries `tabIndex={-1}`: focusable on purpose,
   * never a Tab stop.
   */
  const focusCanvas = useCallback(() => {
    const el = containerRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);

  const onContainerPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // The fixed UI (toolbar, zoom) never becomes pan: capturing the pointer
    // here would swallow the button click.
    if (target.closest(".cv-toolbar, .cv-camera")) return;
    if (!target.closest(".xterm, input, textarea")) focusCanvas();
    // Clicking outside closes the note/text being edited. We can't wait for the
    // native blur: the pan's `preventDefault` (just below) suppresses the
    // compatibility mousedown — which is exactly what would take focus off the
    // textarea. Without this the note stays as raw text forever, never
    // rendering the markdown. A click on a terminal or button truly blurs and
    // falls into `onBlur`.
    // `.cv-mdbar` counts as inside the note: pressing a formatting button is
    // part of writing, not a click away from it.
    if (editingId && !target.closest(".cv-note, .cv-text, .cv-mdbar")) finishEditing();
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
    /**
     * Dragging the empty background with the selection tool draws a rubber
     * band; it used to pan.
     *
     * Panning did not lose anything by it — the wheel, two fingers, the space
     * bar, the middle button and the H tool all still do it — and marquee is
     * the only gesture that can produce a multi-selection at all. Every canvas
     * that has both (Figma, Excalidraw, tldraw) spends the background drag on
     * selection for that reason.
     */
    if (e.button === 0 && tool === "select" && onBg && !spaceHeld) {
      e.preventDefault();
      setConnectFrom(null);
      const w = toWorld(e.clientX, e.clientY);
      const base = e.shiftKey ? selectionRef.current : EMPTY_SEL;
      if (!e.shiftKey) setSelection(EMPTY_SEL);
      marqueeSess.current = { pointerId: e.pointerId, ox: w.x, oy: w.y, base };
      containerRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    const panIntent =
      middle || (e.button === 0 && (spaceHeld || tool === "pan"));
    if (!panIntent) return;
    e.preventDefault();
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

  /** The rubber band as a normalized rectangle, from origin to the pointer. */
  const marqueeLast = useRef({ x: 0, y: 0 });
  const flushMarquee = useCallback(() => {
    const m = marqueeSess.current;
    if (!m) return;
    const w = toWorld(marqueeLast.current.x, marqueeLast.current.y);
    setMarquee({
      x: Math.min(m.ox, w.x),
      y: Math.min(m.oy, w.y),
      w: Math.abs(w.x - m.ox),
      h: Math.abs(w.y - m.oy),
    });
  }, [toWorld]);

  const onContainerPointerMove = (e: React.PointerEvent) => {
    // Unconditional, and deliberately just an assignment: the keyboard has no
    // coordinates of its own, and this is the only handler that sees the
    // pointer travel across the canvas.
    cursorClientRef.current = { x: e.clientX, y: e.clientY };
    const m = marqueeSess.current;
    if (m && e.pointerId === m.pointerId) {
      marqueeLast.current = { x: e.clientX, y: e.clientY };
      scheduleFrame("marquee", flushMarquee);
      return;
    }
    const p = panSess.current;
    if (!p || e.pointerId !== p.pointerId) return;
    panLast.current = { x: e.clientX, y: e.clientY };
    scheduleFrame("pan", flushPan);
  };

  const onContainerPointerUp = (e: React.PointerEvent) => {
    const m = marqueeSess.current;
    if (m && e.pointerId === m.pointerId) {
      marqueeSess.current = null;
      cancelFrame("marquee");
      setMarquee(null);
      const w = toWorld(e.clientX, e.clientY);
      const band: Box = {
        x: Math.min(m.ox, w.x),
        y: Math.min(m.oy, w.y),
        w: Math.abs(w.x - m.ox),
        h: Math.abs(w.y - m.oy),
      };
      // A band smaller than a few screen px is a click, not a drag: it must
      // clear the selection (which is what clicking the background means) and
      // never sweep up whatever happened to be under the cursor.
      const tiny = Math.max(band.w, band.h) * vpRef.current.zoom < 4;
      if (tiny) {
        setSelection(m.base);
        return;
      }
      const next = new Set(m.base);
      for (const [id, b] of Object.entries(allBoxes())) {
        if (boxesIntersect(band, b)) next.add(id);
      }
      setSelection(next.size ? next : EMPTY_SEL);
      return;
    }
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

  /**
   * The offset of the moving set for a pointer position, already magnetized.
   *
   * The snap is computed against the **union** of everything being dragged,
   * not per box: with four cards in hand, letting each find its own guide
   * would tear the group apart. The targets are everything that is standing
   * still — dragging a selection must not make it snap to itself.
   */
  const dragDeltaAt = useCallback(
    (clientX: number, clientY: number) => {
      const s = itemSess.current;
      if (!s) return { dx: 0, dy: 0, guides: [] as SnapGuide[] };
      const w = toWorld(clientX, clientY);
      let dx = w.x - s.sx;
      let dy = w.y - s.sy;
      if (dragFree.current) return { dx, dy, guides: [] as SnapGuide[] };
      const moving: Box = { ...s.union, x: s.union.x + dx, y: s.union.y + dy };
      const targets = Object.entries(allBoxes())
        .filter(([id]) => !s.bases[id])
        .map(([, b]) => b);
      const snap = snapMove(moving, targets, SNAP_TOL / vpRef.current.zoom);
      dx += snap.dx;
      dy += snap.dy;
      return { dx, dy, guides: snap.guides };
    },
    [allBoxes, toWorld],
  );

  const flushItemDrag = useCallback(() => {
    const s = itemSess.current;
    if (!s) return;
    const { dx, dy, guides: g } = dragDeltaAt(itemLast.current.x, itemLast.current.y);
    setItemDragDelta({ ids: s.idSet, dx, dy });
    setGuides(g);
    // The cards in the moving set live in `nodes`, not in `items`: their live
    // preview is an override, the same channel a card drag uses.
    setNodeOverrides((o) => {
      let changed = false;
      const next = { ...o };
      for (const id of s.ids) {
        const base = rectsRef.current[id] ?? undefined;
        if (!base || !s.bases[id]) continue;
        const b = s.bases[id];
        next[id] = { ...base, x: b.x + dx, y: b.y + dy };
        changed = true;
      }
      return changed ? next : o;
    });
  }, [dragDeltaAt]);

  const onItemDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (tool !== "select" || e.button !== 0) return;
      e.stopPropagation();
      focusCanvas();

      // Shift toggles membership and starts no drag: it is the gesture for
      // building a selection item by item, and moving on the same press would
      // nudge whatever was just added.
      if (e.shiftKey) {
        toggleSelected(id);
        return;
      }

      let moving = selectionRef.current;
      // Grabbing something outside the selection replaces it; grabbing a
      // member keeps the group, which is what makes dragging four cards work.
      if (!moving.has(id)) {
        moving = new Set([id]);
        setSelection(moving);
      }

      // Alt duplicates: the copies take the place of the originals under the
      // hand, so the gesture reads as "pull a copy out of this one".
      if (e.altKey) {
        const { copies, ids } = cloneItems(moving, 0, 0);
        if (copies.length) {
          commit((c) => addItems(c, ...copies));
          moving = ids;
          setSelection(ids);
        }
      }

      const w = toWorld(e.clientX, e.clientY);
      const bases: Record<string, Box> = {};
      // Re-read from the store: with Alt the copies were just committed and
      // are not in `itemBoxes` yet (that memo is a render behind).
      const live = currentData().items;
      for (const mid of moving) {
        const r = rectsRef.current[mid];
        if (r) {
          bases[mid] = { x: r.x, y: r.y, w: r.w, h: r.h };
          continue;
        }
        const it = live.find((i) => i.id === mid);
        const b = it && it.type !== "connection" ? itemBounds(it, () => undefined) : null;
        if (b) bases[mid] = b;
      }
      const union = unionBox(bases);
      if (!union) return;
      itemSess.current = {
        pointerId: e.pointerId,
        ids: Object.keys(bases),
        idSet: new Set(Object.keys(bases)),
        sx: w.x,
        sy: w.y,
        bases,
        union,
      };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [cloneItems, commit, currentData, focusCanvas, toWorld, toggleSelected, tool],
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
      const { dx, dy } = dragDeltaAt(e.clientX, e.clientY);
      itemSess.current = null;
      cancelFrame("item");
      setItemDragDelta(null);
      setGuides([]);
      setNodeOverrides((o) => {
        if (!s.ids.some((id) => id in o)) return o;
        const next = { ...o };
        for (const id of s.ids) delete next[id];
        return next;
      });
      if (Math.hypot(dx, dy) <= 0.5) return;
      const moves: Moves = {};
      for (const id of s.ids) moves[id] = { x: s.bases[id].x + dx, y: s.bases[id].y + dy };
      applyMoves(moves);
    },
    [applyMoves, cancelFrame, dragDeltaAt],
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
          (it.type === "note" || it.type === "portal" || it.type === "flow") &&
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
    // Drawing is a canvas gesture: the tool keys and Delete have to keep
    // working right after it, and this overlay swallowed the focus pass.
    focusCanvas();
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
        selectOnly(id);
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
        selectOnly(id);
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
          const exists = currentData().items.find(
            (i) => i.type === "connection" && i.from === from && i.to === nid,
          );
          if (exists) {
            // Repeating the link used to end the gesture without a word — and
            // a connection is the product's access rule, so "already linked"
            // is a useful answer. The cable lights up instead of the silence.
            selectOnly(exists.id);
            useUI.getState().showToast("Esses dois já estão conectados.");
          }
          if (!exists) {
            // Connecting a CLI to a flow card is silent on purpose: nothing is
            // typed into the terminal. What arms the flow is the Enter
            // interception (`lib/flowIntercept.ts`), which reads the cable from here.
            commit((c) => addItems(c, connection(from, nid)));
          }
          setConnectFrom(null);
        } else {
          setConnectFrom(null);
        }
        break;
      }
      case "flow": {
        // The pipeline is born where the click pointed; the editor opens right after.
        createFlowAt(w);
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
    if (tool === "flow") return;
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

  /**
   * The note being edited, lending its editor to the floating bar.
   *
   * A ref and not state: the bar reads it when a button is pressed, and
   * putting the handle in canvas state would repaint the whole board every
   * time an edit opens or closes.
   */
  const noteEditor = useRef<{ id: string; api: NoteEditorApi } | null>(null);
  const registerNoteEditor = useCallback((id: string, api: NoteEditorApi | null) => {
    if (api) noteEditor.current = { id, api };
    // Only the note that registered may clear the slot: closing one note by
    // clicking straight into another registers the new one first.
    else if (noteEditor.current?.id === id) noteEditor.current = null;
  }, []);
  const noteApi = useCallback(() => noteEditor.current?.api ?? null, []);

  /**
   * A checkbox ticked in a note's reading view.
   *
   * By source line, not by "the nth task": a fenced block swallows several
   * lines, so counting rendered items would tick the wrong box in any note
   * that has code in it.
   */
  const toggleNoteTask = useCallback(
    (id: string, line: number) => {
      commit((c) =>
        patchItemById(c, id, (i) => {
          if (i.type !== "note") return i;
          const lines = i.text.split("\n");
          if (lines[line] === undefined) return i;
          const next = toggleTaskLine(lines[line]);
          if (next === lines[line]) return i;
          lines[line] = next;
          return { ...i, text: lines.join("\n") };
        }),
      );
    },
    [commit],
  );

  /**
   * A link followed from a note. It opens the "new portal" sheet with the
   * address filled in — inside Yard the web is a portal on the board, and
   * an `<a href>` in the webview would navigate the app itself away.
   */
  const openNoteLink = useCallback(
    (href: string) => {
      const r = containerRef.current?.getBoundingClientRect();
      const at = r
        ? toWorld(r.left + r.width / 2, r.top + r.height / 2)
        : { x: 80 + PORTAL_DEFAULT_W / 2, y: 80 + PORTAL_DEFAULT_H / 2 };
      openModal("new-portal", {
        groupId,
        x: at.x - PORTAL_DEFAULT_W / 2,
        y: at.y - PORTAL_DEFAULT_H / 2,
        url: href,
      });
    },
    [groupId, openModal, toWorld],
  );

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
   * End of a corner drag on a text: the new font, and the position the
   * anchored corner demands.
   *
   * Pulling the northwest grip grows the text *toward* the top-left, so x/y
   * travel with the size — same rule the note's north/west edges follow.
   */
  const scaleText = useCallback(
    (id: string, next: { fontSize: number; x: number; y: number }) => {
      commit((c) =>
        patchItemById(c, id, (i) => (i.type === "text" ? { ...i, ...next } : i)),
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
        dropFromSelection(it.id);
      }, COMMIT_DEBOUNCE_MS + 60);
    },
    [commit, currentData, dropFromSelection],
  );

  const selectItem = selectOnly;

  /**
   * The press on a card, before it turns into a drag.
   *
   * Cards can't route through `onItemDown` — they own their own gesture — so
   * this is the hook that keeps them under the same selection rules as
   * everything else: Shift toggles membership (and cancels the drag), grabbing
   * an outsider replaces the selection, grabbing a member keeps the group, and
   * Ctrl turns the magnetism off for the gesture.
   */
  const pickNode = useCallback(
    (id: string, e: React.PointerEvent) => {
      if (e.shiftKey) {
        toggleSelected(id);
        return false;
      }
      if (!selectionRef.current.has(id)) selectOnly(id);
      return true;
    },
    [selectOnly, toggleSelected],
  );

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
   *
   * The magnetism is the same one the cards get, on the same terms: only the
   * edges the gesture moved, and off entirely while Ctrl is down. A note
   * whose right edge lines up with a terminal's is the whole reason anyone
   * resizes a note by hand.
   */
  const noteRectNow = useCallback(
    (cx: number, cy: number): { rect: Box; guides: SnapGuide[] } | null => {
      const s = noteSess.current;
      if (!s) return null;
      const z = vpRef.current.zoom;
      const raw = resizeRect(
        s.start,
        s.dir,
        (cx - s.cx) / z,
        (cy - s.cy) / z,
        s.minW,
        s.minH,
      );
      if (dragFree.current) return { rect: raw, guides: [] };
      const targets = Object.entries(allBoxes())
        .filter(([id]) => id !== s.id)
        .map(([, b]) => b);
      return snapResize(raw, s.start, targets, SNAP_TOL / z, s.minW, s.minH);
    },
    [allBoxes],
  );

  const flushNoteResize = useCallback(() => {
    const s = noteSess.current;
    const out = noteRectNow(noteResizeLast.current.x, noteResizeLast.current.y);
    if (!s || !out) return;
    const r = out.rect;
    setNoteResize({ id: s.id, w: r.w, h: r.h });
    setGuides(out.guides);
    const dx = r.x - s.start.x;
    const dy = r.y - s.start.y;
    setItemDragDelta(dx || dy ? { ids: new Set([s.id]), dx, dy } : null);
  }, [noteRectNow]);

  const startNoteResize = useCallback(
    (
      e: React.PointerEvent,
      it: Extract<CanvasItem, { type: "note" | "flow" }>,
      dir: ResizeDir,
    ) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      noteSess.current = {
        id: it.id,
        pointerId: e.pointerId,
        dir,
        cx: e.clientX,
        cy: e.clientY,
        start: { x: it.x, y: it.y, w: it.w, h: it.h },
        minW: it.type === "flow" ? FLOW_MIN_W : NOTE_MIN_W,
        minH: it.type === "flow" ? FLOW_MIN_H : NOTE_MIN_H,
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
      const out = noteRectNow(e.clientX, e.clientY);
      noteSess.current = null;
      cancelFrame("nres");
      setNoteResize(null);
      setItemDragDelta(null);
      setGuides([]);
      if (!out) return;
      const r = out.rect;
      const moved =
        Math.abs(r.w - s.start.w) > 0.5 ||
        Math.abs(r.h - s.start.h) > 0.5 ||
        Math.abs(r.x - s.start.x) > 0.5 ||
        Math.abs(r.y - s.start.y) > 0.5;
      if (!moved) return;
      commit((c) =>
        patchItemById(c, s.id, (i) =>
          i.type === "note" || i.type === "flow"
            ? { ...i, x: r.x, y: r.y, w: r.w, h: r.h }
            : i,
        ),
      );
    },
    [cancelFrame, commit, noteRectNow],
  );

  // --- cards ---

  const nodeLive = useRef<{
    id: string;
    rect: CanvasNode;
    guides: SnapGuide[];
    followers: Moves;
  } | null>(null);

  /**
   * Magnetizes the rectangle a card reports and works out who follows it.
   *
   * The card drives its own gesture (it owns the pointer capture), so this is
   * where the canvas gets to have an opinion: whether the rectangle should
   * stick to a neighbour, and whether the rest of the selection should come
   * along. Move and resize are told apart by the size — a card that kept its
   * width is being dragged, and only then may the selection follow.
   *
   * Everything is measured against `dragBases`, frozen at the first frame:
   * `rects` already carries the live override, and snapping against a
   * rectangle that moves with the pointer drifts a few px per frame.
   */
  const nodeGeometry = useCallback(
    (id: string, rect: CanvasNode) => {
      const bases = dragBases.current;
      const base = bases[id];
      const none = { rect, guides: [] as SnapGuide[], followers: {} as Moves };
      if (!base) return none;

      const targets = Object.entries(allBoxes())
        .filter(([tid]) => !bases[tid])
        .map(([, b]) => b);
      const tol = SNAP_TOL / vpRef.current.zoom;
      const free = dragFree.current;

      if (base.w !== rect.w || base.h !== rect.h) {
        if (free) return none;
        const s = snapResize(rect, base, targets, tol, NODE_MIN_W, NODE_MIN_H);
        return { rect: { ...rect, ...s.rect }, guides: s.guides, followers: {} as Moves };
      }

      let dx = rect.x - base.x;
      let dy = rect.y - base.y;
      let guides: SnapGuide[] = [];
      const union = dragUnion.current;
      if (union && !free) {
        const s = snapMove({ ...union, x: union.x + dx, y: union.y + dy }, targets, tol);
        dx += s.dx;
        dy += s.dy;
        guides = s.guides;
      }
      const followers: Moves = {};
      for (const [fid, b] of Object.entries(bases)) {
        if (fid !== id) followers[fid] = { x: b.x + dx, y: b.y + dy };
      }
      return { rect: { ...rect, x: base.x + dx, y: base.y + dy }, guides, followers };
    },
    [allBoxes],
  );

  const flushNodeLive = useCallback(() => {
    const n = nodeLive.current;
    if (!n) return;
    setGuides(n.guides);
    setNodeOverrides((o) => {
      const next = { ...o, [n.id]: n.rect };
      for (const [fid, p] of Object.entries(n.followers)) {
        const base = rectsRef.current[fid];
        if (base) next[fid] = { ...base, x: p.x, y: p.y };
      }
      return next;
    });
    // Notes and drawings dragged along by a card ride the same channel a note
    // drag uses; the delta is the card's own, so the group moves as one.
    const riders = Object.keys(n.followers).filter((fid) => !rectsRef.current[fid]);
    const anchor = dragBases.current[n.id];
    setItemDragDelta(
      riders.length && anchor
        ? { ids: new Set(riders), dx: n.rect.x - anchor.x, dy: n.rect.y - anchor.y }
        : null,
    );
  }, []);

  const onNodeRect = useCallback(
    (id: string, rect: CanvasNode, phase: RectPhase) => {
      if (!nodeLive.current) {
        // First frame of this gesture: freeze the resting geometry of whatever
        // is going to move — the card alone, or the selection it belongs to.
        const sel = selectionRef.current;
        const group = sel.has(id) && sel.size > 1 ? sel : new Set([id]);
        dragBases.current = boxesOf(group);
        dragUnion.current = unionBox(dragBases.current);
      }
      const g = nodeGeometry(id, rect);
      if (phase === "live") {
        nodeLive.current = { id, ...g };
        scheduleFrame("node", flushNodeLive);
        return;
      }
      // The cancel prevents a late flush from resurrecting the override we
      // just deleted.
      cancelFrame("node");
      const stale = Object.keys(nodeLive.current?.followers ?? {});
      nodeLive.current = null;
      setGuides([]);
      setItemDragDelta(null);
      setNodeOverrides((o) => {
        const next = { ...o };
        delete next[id];
        for (const fid of stale) delete next[fid];
        return next;
      });
      if (phase === "commit") {
        const bases = dragBases.current;
        const boxes = itemBoxesRef.current;
        const rects = rectsRef.current;
        commit((c) => {
          const nodesNext = { ...c.nodes, [id]: g.rect };
          for (const [fid, p] of Object.entries(g.followers)) {
            if (rects[fid]) nodesNext[fid] = { ...rects[fid], x: p.x, y: p.y };
          }
          return {
            ...c,
            nodes: nodesNext,
            items: c.items.map((it) => {
              const target = g.followers[it.id];
              const b = bases[it.id] ?? boxes[it.id];
              return target && b
                ? translateItem(it, target.x - b.x, target.y - b.y)
                : it;
            }),
          };
        });
      }
    },
    [boxesOf, cancelFrame, commit, flushNodeLive, nodeGeometry, scheduleFrame],
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

  /**
   * The board's rectangle on screen — what a portal is allowed to paint in.
   *
   * Read at report time instead of being passed as a prop: it changes with
   * every panel, every window resize and every floor switch, and a prop would
   * re-render every card on the board to tell them something only the portals
   * use. Stable identity, so it does not break `PortalCard`'s memo.
   */
  const getPortalClip = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, []);

  const portalBoundsQ = useRef(new PortalBoundsQueue());
  const flushPortalBounds = useCallback(() => {
    const updates = portalBoundsQ.current.drain();
    if (updates.length > 0) void ipc.portalSetBoundsMany(updates).catch(() => {});
  }, []);
  const onPortalBounds = useCallback(
    (id: string, place: PortalPlace) => {
      portalBoundsQ.current.enqueue(id, place);
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
      // Same magnetism the cards and notes get, on the same terms: only the
      // edges this gesture moved, and off entirely while Ctrl is down.
      let snapped = rect;
      let hints: SnapGuide[] = [];
      if (base && !dragFree.current) {
        const targets = Object.entries(allBoxes())
          .filter(([tid]) => tid !== id)
          .map(([, b]) => b);
        const s = snapResize(
          rect,
          { x: base.x, y: base.y, w: base.w, h: base.h },
          targets,
          SNAP_TOL / vpRef.current.zoom,
          PORTAL_MIN_W,
          PORTAL_MIN_H,
        );
        snapped = s.rect;
        hints = s.guides;
      }
      if (phase === "live") {
        setNoteResize({ id, w: snapped.w, h: snapped.h });
        setGuides(hints);
        if (base) {
          const dx = snapped.x - base.x;
          const dy = snapped.y - base.y;
          setItemDragDelta(dx || dy ? { ids: new Set([id]), dx, dy } : null);
        }
        return;
      }
      setNoteResize(null);
      setItemDragDelta(null);
      setGuides([]);
      if (phase === "commit") {
        commit((c) => patchItemOfType(c, id, "portal", { ...snapped }));
      }
    },
    [allBoxes, commit, currentData],
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
    // Same rule as the selection delete: the flow card leaves, the pipeline
    // it is running stops with it.
    cancelRunsOf([id]);
    commit((c) => removeItemAndEdges(c, id));
    dropFromSelection(id);
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
    selectOnly(copy.id);
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
    if (t.closest(".cv-card, .cv-toolbar, .cv-camera, .menu")) return;
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
    if (hitId && !selectionRef.current.has(hitId)) selectOnly(hitId);
    setCtxMenu({ anchor: { x: e.clientX, y: e.clientY }, itemId: hitId, world: w });
  };

  /**
   * The arrangement block, offered whenever the click lands inside a
   * multi-selection. It replaces the per-item entries in that case: with six
   * cards in hand, "Trazer para a frente" on the one under the cursor is not
   * what anybody meant by right-clicking the group.
   */
  const arrangeEntries = (): MenuEntry[] => [
    {
      id: "align",
      label: "Alinhar",
      icon: <AlignStartVertical size={13} />,
      submenu: [
        {
          id: "left",
          label: "À esquerda",
          icon: <AlignStartVertical size={13} />,
          onSelect: () => alignSelection("left"),
        },
        {
          id: "hcenter",
          label: "Centro (horizontal)",
          icon: <AlignCenterVertical size={13} />,
          onSelect: () => alignSelection("hcenter"),
        },
        {
          id: "right",
          label: "À direita",
          icon: <AlignEndVertical size={13} />,
          onSelect: () => alignSelection("right"),
        },
        { kind: "sep" },
        {
          id: "top",
          label: "Pelo topo",
          icon: <AlignStartHorizontal size={13} />,
          onSelect: () => alignSelection("top"),
        },
        {
          id: "vcenter",
          label: "Centro (vertical)",
          icon: <AlignCenterHorizontal size={13} />,
          onSelect: () => alignSelection("vcenter"),
        },
        {
          id: "bottom",
          label: "Pela base",
          icon: <AlignEndHorizontal size={13} />,
          onSelect: () => alignSelection("bottom"),
        },
      ],
    },
    {
      id: "distribute",
      label: "Distribuir",
      icon: <AlignHorizontalDistributeCenter size={13} />,
      disabled: selection.size < 3,
      submenu: [
        {
          id: "dh",
          label: "Na horizontal",
          icon: <AlignHorizontalDistributeCenter size={13} />,
          onSelect: () => distributeSelection("h"),
        },
        {
          id: "dv",
          label: "Na vertical",
          icon: <AlignVerticalDistributeCenter size={13} />,
          onSelect: () => distributeSelection("v"),
        },
      ],
    },
    {
      id: "tidy",
      label: "Organizar em grade",
      icon: <LayoutGrid size={13} />,
      shortcut: "Ctrl+Shift+T",
      onSelect: tidySelection,
    },
  ];

  /** Menu entries according to the target: each type has its own customization. */
  const ctxMenuItems = (): MenuEntry[] => {
    if (!ctxMenu) return [];
    const it = ctxMenu.itemId
      ? items.find((i) => i.id === ctxMenu.itemId)
      : undefined;

    // Several things in hand, and the click landed on one of them: the menu is
    // about the group, not about whichever member the pointer found. Clicking
    // empty space still gets the background menu — a group being selected is
    // no reason to stop offering "add here".
    if (it && selection.size > 1 && selection.has(it.id)) {
      return [
        ...arrangeEntries(),
        { kind: "sep" },
        {
          id: "copy",
          label: "Copiar",
          icon: <Copy size={13} />,
          shortcut: "Ctrl+C",
          onSelect: () => void copySelection(),
        },
        {
          id: "cut",
          label: "Recortar",
          icon: <Scissors size={13} />,
          shortcut: "Ctrl+X",
          onSelect: () =>
            void copySelection().then((ok) => {
              if (ok) deleteSelection();
            }),
        },
        {
          id: "dup",
          label: "Duplicar",
          icon: <Copy size={13} />,
          shortcut: "Ctrl+D",
          onSelect: duplicateSelection,
        },
        { kind: "sep" },
        {
          id: "fitsel",
          label: "Enquadrar a seleção",
          icon: <ScanSearch size={13} />,
          shortcut: "Shift+2",
          onSelect: fitSelection,
        },
        { kind: "sep" },
        {
          id: "delete",
          label: "Excluir",
          icon: <Trash2 size={13} />,
          danger: true,
          shortcut: "Del",
          onSelect: deleteSelectionAsked,
        },
      ];
    }

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
              // The coordinates travel with the payload instead of being read
              // from the cursor when the modal closes: this menu is *inside*
              // the canvas, so walking down to "Terminal" already moved the
              // pointer away from the point being pointed at.
              onSelect: () => openModal("new-terminal", { groupId, x: w.x, y: w.y }),
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
                selectOnly(id);
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
                selectOnly(id);
                setEditingId(id);
              },
            },
            {
              id: "flow",
              label: "Fluxo de agentes",
              icon: <Workflow size={13} />,
              shortcut: "F",
              onSelect: () => createFlowAt(w),
            },
          ],
        },
        {
          id: "paste",
          label: "Colar aqui",
          icon: <ClipboardPaste size={13} />,
          shortcut: "Ctrl+V",
          onSelect: () => void pasteClipboard(),
        },
        { kind: "sep" },
        {
          id: "selectall",
          label: "Selecionar tudo",
          icon: <SquareDashedMousePointer size={13} />,
          shortcut: "Ctrl+A",
          onSelect: selectAll,
        },
        {
          id: "fit",
          label: "Enquadrar tudo",
          icon: <Expand size={13} />,
          shortcut: "Shift+1",
          onSelect: fitView,
        },
        {
          id: "zoom100",
          label: "Zoom 100%",
          icon: <Maximize2 size={13} />,
          shortcut: "Ctrl+0",
          onSelect: zoomTo100,
        },
        {
          id: "minimap",
          label: minimap ? "Esconder o minimapa" : "Mostrar o minimapa",
          icon: <MapIcon size={13} />,
          shortcut: "Ctrl+Shift+M",
          onSelect: toggleMinimap,
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
          {
            kind: "stepper",
            label: "Fonte",
            value: `${it.fontSize ?? NOTE_FONT_DEFAULT}px`,
            // Dimmed while it is still the default and not this note's own.
            muted: it.fontSize == null,
            mutedTip: "Tamanho padrão da nota",
            onStep: (d) =>
              patchItem(it.id, (i) =>
                i.type === "note"
                  ? {
                      ...i,
                      fontSize: stepFont(
                        i.fontSize ?? NOTE_FONT_DEFAULT,
                        d,
                        NOTE_FONT_MIN,
                        NOTE_FONT_MAX,
                      ),
                    }
                  : i,
              ),
            onReset:
              it.fontSize == null
                ? undefined
                : () =>
                    patchItem(it.id, (i) =>
                      i.type === "note" ? { ...i, fontSize: undefined } : i,
                    ),
            resetTip: "Voltar ao tamanho padrão",
          },
          { kind: "sep" },
          {
            id: "edit",
            label: "Editar nota",
            icon: <Pencil size={13} />,
            onSelect: () => {
              selectOnly(it.id);
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
          // The three presets above are the common sizes; this is everything
          // in between and above them — a text item is also the sign over a
          // region of the board, and no preset reaches that.
          {
            kind: "stepper",
            label: "Fonte",
            value: `${it.fontSize}px`,
            onStep: (d) =>
              patchItem(it.id, (i) =>
                i.type === "text"
                  ? {
                      ...i,
                      fontSize: stepFont(
                        i.fontSize,
                        d,
                        TEXT_FONT_MIN,
                        TEXT_FONT_MAX,
                      ),
                    }
                  : i,
              ),
            onReset:
              it.fontSize === TEXT_FONT_DEFAULT
                ? undefined
                : () =>
                    patchItem(it.id, (i) =>
                      i.type === "text" ? { ...i, fontSize: TEXT_FONT_DEFAULT } : i,
                    ),
            resetTip: "Voltar ao tamanho padrão",
          },
          { kind: "sep" },
          {
            id: "edit",
            label: "Editar texto",
            icon: <Pencil size={13} />,
            onSelect: () => {
              selectOnly(it.id);
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
            onSelect: () => {
              // The state alone is not the sound: the webview keeps playing
              // until the backend is told. Patching without the IPC made the
              // icon and the label lie about a video still audible.
              const muted = !it.muted;
              patchItem(it.id, (i) =>
                i.type === "portal" ? { ...i, muted } : i,
              );
              void ipc.portalSetMuted(it.id, muted).catch((e) => {
                useUI
                  .getState()
                  .showToast(
                    `Não consegui ${muted ? "silenciar" : "reativar o som d"}o portal: ${e}`,
                    "error",
                  );
                // The sound did not change — put the state back so the icon
                // keeps telling the truth.
                patchItem(it.id, (i) =>
                  i.type === "portal" ? { ...i, muted: !muted } : i,
                );
              });
            },
          },
          dup,
          { kind: "sep" },
          ...order,
          { kind: "sep" },
          del,
        ];
      case "flow":
        // No swatches: the flow card is instrument chrome, not a drawing.
        return [
          {
            id: "edit",
            label: "Editar fluxo",
            icon: <Pencil size={13} />,
            onSelect: () => editFlow(it.id),
          },
          dup,
          { kind: "sep" },
          ...order,
          { kind: "sep" },
          del,
        ];
      case "connection":
        // No swatches: the wire is plumbing and always white (see
        // `.cv-conn-line`). Direction is all there is to change here.
        return [
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

  /**
   * How the wire between the flow card and the executing CLI dresses the
   * run: a dash running *toward the CLI* while it runs, green when the
   * pipeline finished, red when it broke. `is-flow-rev` reverses the run
   * when the cable was drawn from the CLI to the flow.
   */
  const flowRuns = useFlows((s) => s.runs);
  const flowClasses = useMemo(() => {
    const m: Record<string, string> = {};
    for (const run of Object.values(flowRuns)) {
      if (run.groupId !== groupId) continue;
      const wire = wireOfPair(items, run.flowId, run.terminalId);
      if (!wire) continue;
      const cls = run.error
        ? "is-flow-error"
        : !run.finishedAt
          ? "is-flow-active"
          : run.cancelled
            ? "is-flow-todo"
            : "is-flow-done";
      m[wire.id] = wire.reversed ? `${cls} is-flow-rev` : cls;
    }
    return m;
  }, [flowRuns, items, groupId]);

  const flowItems = useMemo(
    () => items.filter((i): i is FlowItem => i.type === "flow"),
    [items],
  );

  /** How many agent CLIs each flow card has hanging off it. */
  const flowWired = useMemo(() => {
    const agentIds = new Set(sorted.filter((t) => t.kind === "agent").map((t) => t.id));
    const m: Record<string, number> = {};
    for (const f of flowItems) m[f.id] = 0;
    for (const it of items) {
      if (it.type !== "connection") continue;
      if (it.from in m && agentIds.has(it.to)) m[it.from]++;
      else if (it.to in m && agentIds.has(it.from)) m[it.to]++;
    }
    return m;
  }, [flowItems, items, sorted]);

  const editFlow = useCallback(
    (id: string) => openModal("flow", { groupId, itemId: id }),
    [groupId, openModal],
  );

  const shiftOf = (id: string) =>
    itemDragDelta?.ids.has(id) ? itemDragDelta : { dx: 0, dy: 0 };

  /**
   * Outline around a multi-selection, in live coordinates.
   *
   * Only past one element: with a single note selected the item already draws
   * its own outline, and a second rectangle 8px outside it is noise. It reads
   * `rects` and the drag delta rather than the persisted geometry so the box
   * travels with the group instead of staying behind at the old position.
   */
  const multiBox = useMemo(() => {
    if (selection.size < 2) return null;
    const boxes: Record<string, Box> = {};
    for (const id of selection) {
      const r = rects[id];
      if (r) {
        boxes[id] = { x: r.x, y: r.y, w: r.w, h: r.h };
        continue;
      }
      const b = itemBoxes[id];
      if (!b) continue;
      const live = noteResize?.id === id ? noteResize : null;
      const s = itemDragDelta?.ids.has(id) ? itemDragDelta : null;
      boxes[id] = {
        x: b.x + (s?.dx ?? 0),
        y: b.y + (s?.dy ?? 0),
        w: live?.w ?? b.w,
        h: live?.h ?? b.h,
      };
    }
    return unionBox(boxes);
  }, [selection, rects, itemBoxes, itemDragDelta, noteResize]);

  /**
   * Where the arrangement bar sits: above the selection, clamped to the
   * viewport so it never floats off-screen when the group is half out of frame.
   */
  const selBarAt = useMemo(() => {
    if (!multiBox || marquee) return null;
    const x = (multiBox.x + multiBox.w / 2 - vp.x) * z;
    const y = (multiBox.y - vp.y) * z - 44;
    if (!viewSize.w) return null;
    return {
      x: clamp(x, 150, Math.max(150, viewSize.w - 150)),
      y: clamp(y, 12, Math.max(12, viewSize.h - 60)),
    };
  }, [multiBox, marquee, vp.x, vp.y, z, viewSize.w, viewSize.h]);

  /**
   * Is a *note* being written in? The formatting bar docks itself to the top
   * of the canvas, so there is no geometry to compute here — only whether the
   * thing under the caret is a note and not a piece of drawn text.
   */
  const editingNote = useMemo(
    () => !!editingId && items.find((i) => i.id === editingId)?.type === "note",
    [editingId, items],
  );

  // How many active routines each card carries (clock badge in the header).
  const routineCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of data.routines ?? []) {
      if (r.enabled) m[r.terminalId] = (m[r.terminalId] ?? 0) + 1;
    }
    return m;
  }, [data.routines]);

  /**
   * The camera cluster (map + zoom) floats over the board like the toolbar:
   * without publishing its rectangle a portal card underneath paints the
   * site over it, and the clicks land in the page. One rectangle covers both
   * halves — the pane grows and shrinks with the map, and the ResizeObserver
   * inside the hook republishes it when it does.
   */
  const cameraRef = useRef<HTMLDivElement>(null);
  useOccluder("cv-zoomctl", cameraRef);

  const [cardMenuOpen, setCardMenuOpen] = useState(false);
  const [zoomMenu, setZoomMenu] = useState<MenuAnchor | null>(null);
  // Mounts `.cv-overlay`, the transparent sheet that takes the canvas's
  // pointer events while a tool is armed or a menu is up. It says nothing
  // about the portals any more — see `portalsHidden` below.
  const overlayActive =
    DRAW_TOOLS.includes(tool) || !!modalOpen || !!ctxMenu || !!zoomMenu || cardMenuOpen;

  /**
   * The surfaces that cover the workspace *whole* — a modal, Ao Vivo, the
   * diff, the editor, the composer.
   *
   * These are the only ones that blank a portal outright: no z-index reaches
   * an OS window, and behind a full-screen backdrop there is nothing to see
   * anyway. Everything else that floats over the canvas — every menu, and the
   * transparent `.cv-overlay` a draw tool mounts — publishes its rectangle
   * (`occludersStore`) and only the portals it actually lands on step aside.
   *
   * This used to be `overlayActive` wholesale, which meant picking the pen or
   * right-clicking one card blanked every site on the board.
   */
  const portalsHidden = !!modalOpen || liveOpen || diffOpen || editorOpen || composerOpen;

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

  /**
   * What the minimap paints. Skipped entirely when it is closed — walking
   * every stroke's bounds on each frame of a pan, to feed a hidden `<svg>`,
   * is exactly the kind of work this file spends its comments avoiding.
   */
  const miniBoxes = useMemo<MiniBox[]>(() => {
    if (!minimap) return [];
    const out: MiniBox[] = [];
    for (const t of sorted) {
      const r = rects[t.id];
      if (r) out.push({ id: t.id, kind: "terminal", x: r.x, y: r.y, w: r.w, h: r.h });
    }
    for (const it of items) {
      const b = itemBoxes[it.id];
      if (!b) continue;
      out.push({
        id: it.id,
        kind: it.type === "note" ? "note" : it.type === "portal" ? "portal" : "draw",
        ...b,
      });
    }
    return out;
  }, [minimap, sorted, rects, items, itemBoxes]);

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
      // Focusable, never a Tab stop: the keyboard shortcuts below only fire
      // while focus is in here, and `portalEscape` hands focus back to it.
      tabIndex={-1}
      onPointerDown={onContainerPointerDown}
      onPointerMove={onContainerPointerMove}
      onPointerUp={onContainerPointerUp}
      onContextMenu={onContainerContextMenu}
    >
      {/* What the Tab cycle just selected. See `anunciar`. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div
        className="cv-bg"
        style={{
          backgroundSize: `${GRID * z}px ${GRID * z}px`,
          backgroundPosition: `${(-vp.x * z) % (GRID * z)}px ${(-vp.y * z) % (GRID * z)}px`,
        }}
      />

      {/* Light falling on the table from above. Its own element because
          `.cv-bg` carries the pan offset inline and `background-position`
          would tile the glow along with the dots. */}
      <div className="cv-glow" />

      {/* Wiring under the cards and notes — needs to come before them in the
          DOM so the z-index tie with .cv-note/.cv-text resolves in their
          favor (see .cv-svg--under in styles.css). */}
      <ConnectionsLayer
        items={items}
        rects={anchors}
        vp={vp}
        selection={selection}
        pendingConnect={pendingConnect}
        flowClasses={flowClasses}
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
          const isSel = selection.has(raw.id);
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
                getZoom={getZoom}
                onScale={scaleText}
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
              onBeginEdit={beginTextEdit}
              onPatchText={patchText}
              onEndEdit={endTextEdit}
              onToggleLock={toggleLock}
              focusAtEnd={focusAtEnd}
              registerEditor={registerNoteEditor}
              onToggleTask={toggleNoteTask}
              onOpenLink={openNoteLink}
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
              selected={selection.has(raw.id)}
              faded={pendingErase.has(raw.id)}
              connectClass={connectClass}
              getZoom={getZoom}
              vp={vp}
              covered={portalsHidden}
              layoutTick={layoutTick}
              getClip={getPortalClip}
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

        {flowItems.map((raw) => {
          const { dx, dy } = shiftOf(raw.id);
          const connectClass =
            tool === "connect" && connectFrom === raw.id
              ? "is-connect-source"
              : tool === "connect" && hoverNode === raw.id && connectFrom
                ? "is-connect-target"
                : "";
          return (
            <FlowCard
              key={raw.id}
              it={raw}
              dx={dx}
              dy={dy}
              w={noteResize?.id === raw.id ? noteResize.w : raw.w}
              h={noteResize?.id === raw.id ? noteResize.h : raw.h}
              selected={selection.has(raw.id)}
              faded={pendingErase.has(raw.id)}
              connectClass={connectClass}
              wired={flowWired[raw.id] ?? 0}
              selectTool={tool === "select"}
              onItemDown={onItemDown}
              onItemMove={onItemMove}
              onItemUp={onItemUp}
              onEdit={editFlow}
              onResizeStart={startNoteResize}
              onResizeMove={moveNoteResize}
              onResizeEnd={endNoteResize}
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
            selected={selection.has(t.id)}
            onPick={pickNode}
            role={data.roles?.[t.id]}
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

      <SelectionLayer vp={vp} marquee={marquee} guides={guides} bbox={multiBox} />

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
            aqui mesmo. Arrastar o fundo faz um laço de seleção.
          </p>
          {/* The product's central rule was not stated anywhere in the
              interface — only in the README and the CLI manual. This is where
              it has to appear: before the first cable exists. */}
          <p>
            <kbd>C</kbd> liga um cartão a outro — e o cabo é o que{" "}
            <strong>autoriza um agente a falar com o outro</strong> (e a ler as
            notas ligadas a ele). Sem cabo, cada um só enxerga a si mesmo.
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

      {/* Hidden while a note is open: the arrangement bar floats over the
          selection and the writing bar is docked to the top of the canvas, so
          on a note near the top edge the two would land on each other. You
          are not arranging anything while you type, either. */}
      {selBarAt && !editingNote && (
        <SelectionBar
          at={selBarAt}
          count={selection.size}
          canDistribute={selection.size >= 3}
          onAlign={alignSelection}
          onDistribute={distributeSelection}
          onTidy={tidySelection}
        />
      )}

      {editingNote && <NoteToolbar key={editingId} api={noteApi} />}

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
            {
              id: "fitsel",
              label: "Enquadrar a seleção",
              icon: <ScanSearch size={13} />,
              shortcut: "Shift+2",
              disabled: selection.size === 0,
              onSelect: fitSelection,
            },
            {
              id: "minimap",
              label: minimap ? "Esconder o minimapa" : "Mostrar o minimapa",
              icon: <MapIcon size={13} />,
              shortcut: "Ctrl+Shift+M",
              onSelect: toggleMinimap,
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

      {tool === "flow" && (
        <div className="cv-status">
          Clique onde o cartão do fluxo deve nascer — depois conecte uma CLI a
          ele (tecla C) para armá-lo.
        </div>
      )}

      <FlowHud
        groupId={groupId}
        flows={flowItems}
        onReveal={focusNode}
        onDraw={() => setTool("flow")}
      />

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

      {/* Map and zoom in one pane of glass: both answer "where am I?", and
          stacked as two floaters with a gap between them they read as two
          unrelated controls that happened to land in the same corner. */}
      <div className="cv-camera" ref={cameraRef}>
        {minimap && (
          <Minimap
            boxes={miniBoxes}
            vp={vp}
            view={viewSize}
            selection={selection}
            onJump={centerOn}
            onClose={toggleMinimap}
          />
        )}

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
          {/* Left of the line: change the zoom. Right of it: change the
              frame. Two different questions, one strip. */}
          <span className="cv-zoom-sep" aria-hidden="true" />
          <button
            className="icon-btn"
            data-tip-side="top" data-tip="Enquadrar tudo (Shift+1)"
            aria-label="Enquadrar tudo"
            onClick={fitView}
          >
            <Expand size={13} />
          </button>
          <button
            className={`icon-btn ${minimap ? "is-active" : ""}`}
            data-tip-side="top" data-tip="Minimapa (Ctrl+Shift+M)"
            aria-label="Minimapa"
            aria-pressed={minimap}
            onClick={toggleMinimap}
          >
            <MapIcon size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
