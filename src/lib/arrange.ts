/**
 * Arrangement of a multi-selection: align, distribute, tidy and magnetic
 * snapping. All pure `Box -> Box` geometry, no React and no store.
 *
 * It lives outside `canvas.ts` because none of it touches the persisted
 * shape: these functions take the rectangles the canvas already computed
 * (cards from `nodes`, everything else from `itemBounds`) and answer where
 * they *should* be. The caller turns the answer into a commit.
 *
 * Coordinates are always "world" px — the same units `CanvasNode` uses.
 */
import type { Box } from "./canvas";

/** Where the moved boxes should end up, keyed by id. Only movers are listed. */
export type Moves = Record<string, { x: number; y: number }>;

export type AlignKind = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type DistributeKind = "h" | "v";
/** Tidy cycles through these on each press of Ctrl+Shift+T. */
export type TidyLayout = "grid" | "row" | "column";

export const TIDY_ORDER: readonly TidyLayout[] = ["grid", "row", "column"];

/** Breathing room between tidied boxes, in world px. */
export const TIDY_GAP = 48;

/** Bounding box of everything in the map. `null` when it is empty. */
export function unionBox(boxes: Record<string, Box>): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const b of Object.values(boxes)) {
    any = true;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!any) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Do the two rectangles touch at all? The marquee's hit test. */
export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  );
}

/** Drops entries that would not move — an empty commit is still a commit. */
function pruned(moves: Moves, boxes: Record<string, Box>): Moves {
  const out: Moves = {};
  for (const [id, p] of Object.entries(moves)) {
    const b = boxes[id];
    if (!b) continue;
    if (Math.abs(p.x - b.x) > 0.01 || Math.abs(p.y - b.y) > 0.01) out[id] = p;
  }
  return out;
}

/**
 * Aligns every box against the selection's own bounding box.
 *
 * The reference is the union and not "the first one selected": with a marquee
 * there is no first, and aligning to the outer edge is what people mean when
 * they drag a box around four cards and hit "align left".
 */
export function alignBoxes(boxes: Record<string, Box>, kind: AlignKind): Moves {
  const u = unionBox(boxes);
  if (!u) return {};
  const moves: Moves = {};
  for (const [id, b] of Object.entries(boxes)) {
    let { x, y } = b;
    switch (kind) {
      case "left":
        x = u.x;
        break;
      case "hcenter":
        x = u.x + (u.w - b.w) / 2;
        break;
      case "right":
        x = u.x + u.w - b.w;
        break;
      case "top":
        y = u.y;
        break;
      case "vcenter":
        y = u.y + (u.h - b.h) / 2;
        break;
      case "bottom":
        y = u.y + u.h - b.h;
        break;
    }
    moves[id] = { x, y };
  }
  return pruned(moves, boxes);
}

/**
 * Evens out the *gaps*, not the centers.
 *
 * Distributing centers is the naive reading and it looks wrong the moment the
 * boxes have different sizes: a 640px terminal next to a 140px note ends up
 * visually crowded on one side. Equal gaps is what the eye reads as evenly
 * spaced. The two outermost boxes never move — they define the span.
 */
export function distributeBoxes(
  boxes: Record<string, Box>,
  kind: DistributeKind,
): Moves {
  const entries = Object.entries(boxes);
  if (entries.length < 3) return {};
  const horiz = kind === "h";
  const sorted = entries
    .slice()
    .sort((a, b) =>
      horiz
        ? a[1].x + a[1].w / 2 - (b[1].x + b[1].w / 2)
        : a[1].y + a[1].h / 2 - (b[1].y + b[1].h / 2),
    );

  const first = sorted[0][1];
  const last = sorted[sorted.length - 1][1];
  const start = horiz ? first.x : first.y;
  const end = horiz ? last.x + last.w : last.y + last.h;
  const sizes = sorted.map(([, b]) => (horiz ? b.w : b.h));
  const totalSize = sizes.reduce((s, v) => s + v, 0);
  const gap = (end - start - totalSize) / (sorted.length - 1);

  const moves: Moves = {};
  let cursor = start;
  for (let i = 0; i < sorted.length; i++) {
    const [id, b] = sorted[i];
    moves[id] = horiz ? { x: cursor, y: b.y } : { x: b.x, y: cursor };
    cursor += sizes[i] + gap;
  }
  return pruned(moves, boxes);
}

/**
 * Lays the selection out again from its own top-left corner.
 *
 * The grid uses one uniform cell (the widest and the tallest box) so the
 * columns line up even with a note beside a terminal — a packed layout would
 * be denser and would not read as a grid. Reading order is preserved: boxes
 * are sorted by row band and then by x, so tidying does not shuffle a board
 * the user already arranged roughly.
 */
export function tidyBoxes(
  boxes: Record<string, Box>,
  layout: TidyLayout,
  gap = TIDY_GAP,
): Moves {
  const entries = Object.entries(boxes);
  if (entries.length < 2) return {};
  const u = unionBox(boxes)!;

  const cellW = Math.max(...entries.map(([, b]) => b.w));
  const cellH = Math.max(...entries.map(([, b]) => b.h));

  // Row banding: two boxes belong to the same row when their centers sit
  // within half a cell of each other. Sorting by raw y would interleave a
  // tall terminal with the short note sitting beside it.
  const ordered = entries.slice().sort((a, b) => {
    const band =
      Math.floor((a[1].y + a[1].h / 2 - u.y) / Math.max(cellH, 1)) -
      Math.floor((b[1].y + b[1].h / 2 - u.y) / Math.max(cellH, 1));
    return band !== 0 ? band : a[1].x - b[1].x;
  });

  const cols =
    layout === "row"
      ? ordered.length
      : layout === "column"
        ? 1
        : Math.ceil(Math.sqrt(ordered.length));

  const moves: Moves = {};
  ordered.forEach(([id], i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    moves[id] = {
      x: u.x + col * (cellW + gap),
      y: u.y + row * (cellH + gap),
    };
  });
  return pruned(moves, boxes);
}

// ---------------------------------------------------------------------------
// magnetic snapping
// ---------------------------------------------------------------------------

/**
 * A guide to paint while the gesture is live: an infinite-ish line at `at`
 * on `axis`, drawn only across the span the two boxes share so it reads as
 * "these two agree here" rather than as a full-screen ruler.
 */
export interface SnapGuide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export interface SnapMove {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/** The three interesting lines of a box on one axis: near edge, center, far edge. */
function lines(b: Box, axis: "x" | "y"): [number, number, number] {
  return axis === "x"
    ? [b.x, b.x + b.w / 2, b.x + b.w]
    : [b.y, b.y + b.h / 2, b.y + b.h];
}

interface AxisHit {
  /** How much to add to the moving box on this axis. */
  delta: number;
  /** World coordinate of the line both sides landed on. */
  at: number;
  targets: Box[];
}

/**
 * Closest agreement between `moving` and any target on one axis.
 *
 * Every combination of (one of the mover's three lines, one of a target's
 * three) is a candidate; the smallest offset within `tol` wins, and every
 * target that lands on that same line joins the guide list — which is what
 * makes a column of four cards light up as one guide instead of one per pair.
 */
function bestAxis(
  moving: Box,
  targets: Box[],
  tol: number,
  axis: "x" | "y",
): AxisHit | null {
  const mine = lines(moving, axis);
  let best: { delta: number; at: number; dist: number } | null = null;
  for (const t of targets) {
    for (const theirs of lines(t, axis)) {
      for (const own of mine) {
        const dist = Math.abs(theirs - own);
        if (dist > tol) continue;
        if (!best || dist < best.dist - 0.001) {
          best = { delta: theirs - own, at: theirs, dist };
        }
      }
    }
  }
  if (!best) return null;
  const at = best.at;
  const hit = targets.filter((t) => lines(t, axis).some((v) => Math.abs(v - at) < 0.01)); // i18n-ok
  return { delta: best.delta, at, targets: hit };
}

/** The guide segment: from the topmost to the bottommost of everyone involved. */
function guideFor(axis: "x" | "y", at: number, moved: Box, targets: Box[]): SnapGuide {
  const cross = axis === "x" ? ("y" as const) : ("x" as const);
  const size = axis === "x" ? "h" : "w";
  let from = moved[cross];
  let to = moved[cross] + moved[size];
  for (const t of targets) {
    from = Math.min(from, t[cross]);
    to = Math.max(to, t[cross] + t[size]);
  }
  return { axis, at, from, to };
}

/**
 * Nudges a dragged box onto the nearest alignment with the boxes that are
 * standing still. `tol` should already be divided by the zoom: magnetism is a
 * screen-distance idea, so zoomed out it has to cover more world px.
 */
export function snapMove(moving: Box, targets: Box[], tol: number): SnapMove {
  if (targets.length === 0) return { dx: 0, dy: 0, guides: [] };
  const hx = bestAxis(moving, targets, tol, "x");
  const hy = bestAxis(moving, targets, tol, "y");
  const dx = hx?.delta ?? 0;
  const dy = hy?.delta ?? 0;
  const moved: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: SnapGuide[] = [];
  if (hx) guides.push(guideFor("x", hx.at, moved, hx.targets));
  if (hy) guides.push(guideFor("y", hy.at, moved, hy.targets));
  return { dx, dy, guides };
}

export interface SnapResize {
  rect: Box;
  guides: SnapGuide[];
}

/**
 * Same magnetism for a resize: only the edges the gesture actually moved are
 * allowed to snap, so pulling the east handle never drags the west side along.
 *
 * `base` is the rectangle before the gesture — comparing against it is how we
 * know which handle is in the user's hand without the caller telling us.
 */
export function snapResize(
  rect: Box,
  base: Box,
  targets: Box[],
  tol: number,
  minW: number,
  minH: number,
): SnapResize {
  if (targets.length === 0) return { rect, guides: [] };
  const out = { ...rect };
  const guides: SnapGuide[] = [];

  const edges: {
    axis: "x" | "y";
    moved: boolean;
    value: number;
    apply: (v: number) => void;
  }[] = [
    {
      axis: "x",
      moved: Math.abs(rect.x - base.x) > 0.01,
      value: rect.x,
      apply: (v) => {
        const right = out.x + out.w;
        out.x = Math.min(v, right - minW);
        out.w = right - out.x;
      },
    },
    {
      axis: "x",
      moved: Math.abs(rect.x + rect.w - (base.x + base.w)) > 0.01,
      value: rect.x + rect.w,
      apply: (v) => {
        out.w = Math.max(minW, v - out.x);
      },
    },
    {
      axis: "y",
      moved: Math.abs(rect.y - base.y) > 0.01,
      value: rect.y,
      apply: (v) => {
        const bottom = out.y + out.h;
        out.y = Math.min(v, bottom - minH);
        out.h = bottom - out.y;
      },
    },
    {
      axis: "y",
      moved: Math.abs(rect.y + rect.h - (base.y + base.h)) > 0.01,
      value: rect.y + rect.h,
      apply: (v) => {
        out.h = Math.max(minH, v - out.y);
      },
    },
  ];

  for (const e of edges) {
    if (!e.moved) continue;
    let best: { at: number; dist: number } | null = null;
    for (const t of targets) {
      for (const theirs of lines(t, e.axis)) {
        const dist = Math.abs(theirs - e.value);
        if (dist <= tol && (!best || dist < best.dist)) best = { at: theirs, dist };
      }
    }
    if (!best) continue;
    e.apply(best.at);
    const at = best.at;
    const hit = targets.filter((t) =>
      lines(t, e.axis).some((v) => Math.abs(v - at) < 0.01), // i18n-ok
    );
    guides.push(guideFor(e.axis, at, out, hit));
  }

  return { rect: out, guides };
}

// ---------------------------------------------------------------------------
// the grid
// ---------------------------------------------------------------------------

/** The nearest grid line to `v`. Never returns a negative zero. */
export function snapToGrid(v: number, size: number): number {
  const s = Math.round(v / size) * size;
  return s === 0 ? 0 : s;
}

/**
 * A box on the grid. Moving snaps the origin and keeps the size; resizing
 * snaps the far edges and keeps the origin, so the corner in the hand is the
 * one that lands on a line. A box never shrinks below one cell.
 */
export function snapBoxToGrid(box: Box, size: number, mode: "move" | "resize"): Box {
  if (mode === "move") return { ...box, x: snapToGrid(box.x, size), y: snapToGrid(box.y, size) };
  return {
    ...box,
    w: Math.max(size, snapToGrid(box.x + box.w, size) - box.x),
    h: Math.max(size, snapToGrid(box.y + box.h, size) - box.y),
  };
}

/**
 * A resize on the grid: only the edges that moved since `base` snap, each
 * to its own line, so pulling the west side never makes the east side
 * twitch. An edge cannot cross the opposite one; one cell is the floor.
 */
export function snapResizeToGrid(rect: Box, base: Box, size: number): Box {
  const out = { ...rect };
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (Math.abs(rect.x - base.x) > 0.01) {
    out.x = Math.min(snapToGrid(rect.x, size), right - size);
    out.w = right - out.x;
  }
  if (Math.abs(right - (base.x + base.w)) > 0.01) {
    out.w = Math.max(size, snapToGrid(right, size) - out.x);
  }
  if (Math.abs(rect.y - base.y) > 0.01) {
    out.y = Math.min(snapToGrid(rect.y, size), bottom - size);
    out.h = bottom - out.y;
  }
  if (Math.abs(bottom - (base.y + base.h)) > 0.01) {
    out.h = Math.max(size, snapToGrid(bottom, size) - out.y);
  }
  return out;
}
