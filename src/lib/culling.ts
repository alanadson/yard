/**
 * Which elements of the board are worth painting right now.
 *
 * A canvas with forty cards has six on screen. The other thirty-four keep
 * their processes and their output (the PTY lives in the backend), but the
 * xterm of each one repaints on every chunk it receives, and a note renders
 * its markdown on every commit, whether anyone can see it or not. This rule
 * says who is inside the viewport, with a margin of one screen on every side
 * so a pan never reveals a card still being mounted.
 *
 * Pure: boxes in, ids out.
 */
import type { Box } from "./canvas";

/**
 * The ids whose box intersects the view inflated by `margin` screens, plus
 * everything in `keep` (the focused card, the selection, a note being
 * written). With no view size yet, nothing is culled: the first frame of a
 * board must not be empty.
 */
export function visibleIds(
  boxes: Record<string, Box>,
  view: Box,
  keep: Iterable<string>,
  margin = 1,
): Set<string> {
  const out = new Set<string>(keep);
  if (!(view.w > 0) || !(view.h > 0)) {
    for (const id of Object.keys(boxes)) out.add(id);
    return out;
  }
  const mx = view.w * margin;
  const my = view.h * margin;
  const x0 = view.x - mx;
  const y0 = view.y - my;
  const x1 = view.x + view.w + mx;
  const y1 = view.y + view.h + my;
  for (const [id, b] of Object.entries(boxes)) {
    if (b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0) out.add(id);
  }
  return out;
}

/** Below this share of the view, a box is not "the one being looked at". */
const LARGEST_MIN_SHARE = 0.01;

/**
 * The box covering the most of the view, by its *visible* area, or `null`
 * when nothing covers even one percent of it. What the optional auto-focus
 * reads after the camera settles: the terminal that fills the screen is the
 * one the keyboard should reach.
 */
export function largestVisible(boxes: Record<string, Box>, view: Box): string | null {
  const floor = view.w * view.h * LARGEST_MIN_SHARE;
  let best: { id: string; area: number } | null = null;
  for (const [id, b] of Object.entries(boxes)) {
    const w = Math.min(b.x + b.w, view.x + view.w) - Math.max(b.x, view.x);
    const h = Math.min(b.y + b.h, view.y + view.h) - Math.max(b.y, view.y);
    if (w <= 0 || h <= 0) continue;
    const area = w * h;
    if (area >= floor && (!best || area > best.area)) best = { id, area };
  }
  return best?.id ?? null;
}
