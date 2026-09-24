/**
 * The board's geometry maps, split by how often they move.
 *
 * Almost nothing on the board moves when the camera does: a card, a note or a
 * stroke stays where it was put, and only what is docked to a screen edge
 * (`lib/canvasDock.ts`) has to be placed again on every frame of a pan or a
 * zoom. Building each map in one pass that read the camera put the whole
 * board on that hot path (a stroke's bounds walk all of its points) and handed
 * every memo downstream a fresh object per frame, so the culling, the
 * minimap and the selection outline redid their work for a board that had not
 * changed.
 *
 * So each map is built in two steps. The layer is built without the camera:
 * every entry where it rests, docked ones included (which keeps the key order
 * the single pass produced), plus which entries are docked and to which edge.
 * Placing it for a camera then touches only the docked entries, and returns
 * the layer's own map, the very same object, when nothing is docked.
 */
import {
  itemBounds,
  type Box,
  type CanvasItem,
  type CanvasNode,
  type CanvasViewport,
} from "../../lib/canvas";
import { canDock, dockWorldRect, type DockSide } from "../../lib/canvasDock";

type Size = { w: number; h: number };

export interface DockLayer<T> {
  /** Every entry at its resting geometry, in the order the single pass wrote them. */
  base: Record<string, T>;
  /** The entries pinned to a screen edge, and which edge. Empty when nothing is docked. */
  docked: ReadonlyMap<string, DockSide>;
}

/**
 * What a placement has to be re-run for, as memo dependencies: the camera and
 * the screen size while something in the layer is docked, `null` otherwise.
 * With nothing docked the placement is the layer's own map whatever the camera
 * does, so leaving the camera out keeps a pan from even re-running it.
 */
export function cameraWhileDocked(
  layer: DockLayer<unknown>,
  vp: CanvasViewport,
  size: Size,
): readonly [CanvasViewport | null, Size | null] {
  return layer.docked.size > 0 ? [vp, size] : [null, null];
}

/** `base` itself when nothing is docked, else a copy with the docked entries placed. */
function placeDocked<T>(layer: DockLayer<T>, place: (side: DockSide, resting: T) => T): Record<string, T> {
  if (layer.docked.size === 0) return layer.base;
  const m = { ...layer.base };
  for (const [id, side] of layer.docked) m[id] = place(side, layer.base[id]);
  return m;
}

// --- selectable items ---

/**
 * Everything selectable that is not a card, as a plain rectangle. A filed
 * note has no rectangle on the board: its `x`/`y` are wherever it sat before
 * it was filed, and leaving them here would put an invisible box in the
 * marquee's way, in a frame's membership test and in "enquadrar tudo".
 */
export function itemBoxLayer(items: readonly CanvasItem[], filed: ReadonlySet<string>): DockLayer<Box> {
  const base: Record<string, Box> = {};
  const docked = new Map<string, DockSide>();
  for (const it of items) {
    if (it.type === "connection") continue;
    if (it.type === "note" && filed.has(it.id)) continue;
    const b = itemBounds(it, () => undefined);
    if (!b) continue;
    base[it.id] = b;
    // Last write wins, as it did in the single pass: a later item with the
    // same id that is not docked takes the entry back.
    if (it.dock && canDock(it)) docked.set(it.id, it.dock);
    else docked.delete(it.id);
  }
  return { base, docked };
}

export function placeItemBoxes(layer: DockLayer<Box>, vp: CanvasViewport, size: Size): Record<string, Box> {
  return placeDocked(layer, (side) => dockWorldRect(side, vp, size));
}

// --- terminal cards ---

/** Each card's resting rectangle: the live override, else the saved node, else its automatic spot. */
export function cardLayer(
  cards: readonly { id: string }[],
  nodes: Record<string, CanvasNode>,
  overrides: Record<string, CanvasNode>,
  autoRects: readonly CanvasNode[],
): DockLayer<CanvasNode> {
  const base: Record<string, CanvasNode> = {};
  const docked = new Map<string, DockSide>();
  cards.forEach((t, i) => {
    const r = overrides[t.id] ?? nodes[t.id] ?? autoRects[i];
    base[t.id] = r;
    if (r.dock) docked.set(t.id, r.dock);
    else docked.delete(t.id);
  });
  return { base, docked };
}

/** A docked card keeps everything it paints from; only its rectangle follows the edge, and it is pinned. */
export function placeCards(
  layer: DockLayer<CanvasNode>,
  vp: CanvasViewport,
  size: Size,
): Record<string, CanvasNode> {
  return placeDocked(layer, (side, r) => ({ ...r, ...dockWorldRect(side, vp, size), pinned: true }));
}

// --- connection anchors ---

export interface AnchorLayer extends DockLayer<CanvasNode> {
  /**
   * The map before filed notes were pointed at their fichário, read only when
   * something is docked. Placing the docked entries replays that last pass on
   * top of this one, so a note filed in a docked binder lands on the binder's
   * edge, exactly as when the filed pass ran after the docked one.
   */
  resting: Record<string, CanvasNode>;
  binders: readonly Extract<CanvasItem, { type: "binder" }>[];
}

/** Filed notes anchor on the fichário showing them (mutates `m`). */
function pointFiledAtBinders(
  m: Record<string, CanvasNode>,
  binders: readonly Extract<CanvasItem, { type: "binder" }>[],
) {
  for (const it of binders) {
    const box = m[it.id];
    if (!box) continue;
    for (const id of it.notes) m[id] = box;
  }
}

/**
 * What a wire can land on: the cards (`rects`, already placed for the camera)
 * and every card-like item, carried along by the live drag and resize so the
 * cable stays glued to a note in the middle of a gesture.
 */
export function anchorLayer(
  rects: Record<string, CanvasNode>,
  items: readonly CanvasItem[],
  noteDrag: { ids: ReadonlySet<string>; dx: number; dy: number } | null,
  noteResize: { id: string; w: number; h: number } | null,
): AnchorLayer {
  const m: Record<string, CanvasNode> = { ...rects };
  const docked = new Map<string, DockSide>();
  const binders: Extract<CanvasItem, { type: "binder" }>[] = [];
  for (const it of items) {
    if (it.type === "binder") binders.push(it);
    if (
      it.type !== "note" &&
      it.type !== "portal" &&
      it.type !== "flow" &&
      it.type !== "binder" &&
      it.type !== "tree" &&
      it.type !== "media" &&
      it.type !== "doc"
    )
      continue;
    const live = noteResize?.id === it.id ? noteResize : null;
    const shift = noteDrag?.ids.has(it.id) ? noteDrag : null;
    m[it.id] = {
      x: it.x + (shift?.dx ?? 0),
      y: it.y + (shift?.dy ?? 0),
      w: live?.w ?? it.w,
      h: live?.h ?? it.h,
    };
  }
  // Only ever set, never cleared: in the single pass any docked item with
  // this id sent the entry to the edge, whatever came after it.
  for (const it of items) if (it.dock && canDock(it)) docked.set(it.id, it.dock);
  // A filed note has no rectangle of its own on the board, but the wires
  // drawn to it are still live: the agent connected to it still reads and
  // writes it through the CLI. They anchor on the fichário that is showing
  // it, which is also where the user's eye expects the cable to land.
  // The copy is only paid when the docked placement will need the map as it
  // was before this pass; with nothing docked `resting` is never read.
  const base = docked.size > 0 && binders.length > 0 ? { ...m } : m;
  pointFiledAtBinders(base, binders);
  return { base, resting: m, docked, binders };
}

export function placeAnchors(layer: AnchorLayer, vp: CanvasViewport, size: Size): Record<string, CanvasNode> {
  if (layer.docked.size === 0) return layer.base;
  const m = { ...layer.resting };
  for (const [id, side] of layer.docked) m[id] = dockWorldRect(side, vp, size);
  pointFiledAtBinders(m, layer.binders);
  return m;
}
