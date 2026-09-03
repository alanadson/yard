/**
 * Where a new card is offered a place on a board that already has things.
 *
 * "At the cursor" is right until the cursor is over a card, and "the next
 * free slot of a grid" is right until the board stopped being a grid. What
 * a person does by hand is look for the empty pocket nearest to where they
 * are and drop the card one gap away from its neighbour. This module does
 * that, and offers the runners-up too, numbered, so the second choice is a
 * keystroke and not a drag.
 *
 * Pure geometry: the visible area, the boxes already there, the size to
 * place and the point to rank from. No React, no store.
 */
import { filedNoteIds } from "./binder";
import { itemBounds, type Box, type CanvasData } from "./canvas";

/** Breathing room kept between a new card and whatever it lands beside. */
export const PLACEMENT_GAP = 40;
/** How many spots are offered at most: past six, the numbers stop helping. */
export const PLACEMENT_MAX = 6;
/** Free rectangles kept per pass; a crowded board decomposes into thousands. */
const FREE_CAP = 80;

/** Window event: a card was placed and the runners-up are worth showing. */
export const PLACEMENT_HINTS_EVENT = "yard:placement-hints";

export interface PlacementHints {
  groupId: string;
  /** The card just placed (at `spots[0]`). */
  id: string;
  spots: Box[];
}

export interface PlaceRequest {
  /** Where a new box may go, in world units (usually the visible view). */
  area: Box;
  /** What already stands on the board. */
  obstacles: Box[];
  /** Size of the thing being placed. */
  size: { w: number; h: number };
  /** The point the offers are ranked from: the cursor, or the middle of the view. */
  anchor: { x: number; y: number };
  gap?: number;
  max?: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

function inflate(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 };
}

/** The (up to four) rectangles left of `free` once `ob` is taken out of it. */
function cut(free: Box, ob: Box): Box[] {
  if (!overlaps(free, ob)) return [free];
  const out: Box[] = [];
  const freeR = free.x + free.w;
  const freeB = free.y + free.h;
  const obR = ob.x + ob.w;
  const obB = ob.y + ob.h;
  if (ob.x > free.x) out.push({ x: free.x, y: free.y, w: ob.x - free.x, h: free.h });
  if (obR < freeR) out.push({ x: obR, y: free.y, w: freeR - obR, h: free.h });
  if (ob.y > free.y) out.push({ x: free.x, y: free.y, w: free.w, h: ob.y - free.y });
  if (obB < freeB) out.push({ x: free.x, y: obB, w: free.w, h: freeB - obB });
  return out;
}

/**
 * Drops what cannot hold the size and what sits inside another rectangle,
 * then keeps the largest few. Maximal rectangles overlap each other on
 * purpose: that is what lets a spot be found across a corner.
 */
function prune(rects: Box[], minW: number, minH: number): Box[] {
  const fit = rects.filter((r) => r.w >= minW && r.h >= minH);
  const kept = fit.filter(
    (r, i) =>
      !fit.some((o, j) => {
        if (j === i || !contains(o, r)) return false;
        // Two identical rectangles: the first survives, the other goes.
        return !contains(r, o) || j < i;
      }),
  );
  return kept.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, FREE_CAP);
}

/** The maximal empty rectangles of `area` once the obstacles are taken out. */
export function freeRects(area: Box, obstacles: Box[], minW: number, minH: number): Box[] {
  let free: Box[] = [area];
  for (const ob of obstacles) {
    const next: Box[] = [];
    for (const f of free) next.push(...cut(f, ob));
    free = prune(next, minW, minH);
  }
  return prune(free, minW, minH);
}

/**
 * The spots, nearest to the anchor first.
 *
 * Every obstacle is inflated by the gap, so a spot that touches the free
 * space's edge sits exactly one gap from its neighbour. Each spot picked is
 * carved out (inflated too) before the next is looked for, which is what
 * keeps the offers apart from one another. An empty board gets one offer:
 * with nothing to arrange against, runners-up would only be noise.
 */
export function placementCandidates(req: PlaceRequest): Box[] {
  const gap = req.gap ?? PLACEMENT_GAP;
  const max = req.max ?? PLACEMENT_MAX;
  const { size, anchor } = req;
  let free = freeRects(
    req.area,
    req.obstacles.map((o) => inflate(o, gap)),
    size.w,
    size.h,
  );
  const out: Box[] = [];
  while (out.length < max && free.length > 0) {
    let best: { x: number; y: number; d: number } | null = null;
    for (const r of free) {
      const x = Math.min(Math.max(anchor.x - size.w / 2, r.x), r.x + r.w - size.w);
      const y = Math.min(Math.max(anchor.y - size.h / 2, r.y), r.y + r.h - size.h);
      const d = Math.hypot(x + size.w / 2 - anchor.x, y + size.h / 2 - anchor.y);
      if (!best || d < best.d - 1e-9) best = { x, y, d };
    }
    if (!best) break;
    const box = { x: best.x, y: best.y, w: size.w, h: size.h };
    out.push(box);
    if (req.obstacles.length === 0) break;
    const carve = inflate(box, gap);
    const next: Box[] = [];
    for (const f of free) next.push(...cut(f, carve));
    free = prune(next, size.w, size.h);
  }
  return out;
}

/**
 * Everything on the board that takes room: the cards and every item with a
 * rectangle. Wires have none, and a note filed in a binder is drawn by the
 * binder, so its own (stale) rectangle must not block a spot.
 */
export function boardBoxes(c: CanvasData): Box[] {
  const out: Box[] = Object.values(c.nodes).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  const filed = filedNoteIds(c.items);
  for (const it of c.items) {
    if (it.type === "connection") continue;
    if (it.type === "note" && filed.has(it.id)) continue;
    const b = itemBounds(it, () => undefined);
    if (b) out.push(b);
  }
  return out;
}
