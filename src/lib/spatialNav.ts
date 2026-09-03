/**
 * Which card is "the one to the right" of another.
 *
 * Keyboard travel across the board needs a spatial answer, not a list order:
 * `Tab` walks the cards in creation order, which is fine for a screen reader
 * and useless for a person looking at a board where the next card in time
 * sits three screens away. This module answers the question the eye asks.
 *
 * Pure geometry over rectangles, so it can be tested with numbers.
 */
import type { Box } from "./canvas";

export type Direction = "left" | "right" | "up" | "down";

interface Point {
  x: number;
  y: number;
}

/**
 * How much a sideways offset costs compared with distance ahead. Two, so a
 * card a little further along but on the same line beats one that is closer
 * yet visibly off to the side, which is what "the next one to the right" means.
 */
const SIDE_WEIGHT = 2;

function centre(b: Box): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * The nearest box in `dir` from `fromId`, by centre to centre.
 *
 * Two passes with one rule each. First the **cone**: candidates whose offset
 * along the axis dominates the sideways offset (a 90 degree wedge); the best
 * of those wins by `ahead + SIDE_WEIGHT * side`. Only when the wedge is
 * empty does a candidate anywhere in the forward half plane count, so a lone
 * card up in the diagonal is still reachable and the key never does nothing
 * while something is ahead. Nothing behind the origin ever qualifies.
 */
export function nearestInDirection(
  fromId: string,
  boxes: Record<string, Box>,
  dir: Direction,
): string | null {
  const origin = boxes[fromId];
  if (!origin) return null;
  const o = centre(origin);
  let cone: { id: string; score: number } | null = null;
  let any: { id: string; score: number } | null = null;
  for (const [id, b] of Object.entries(boxes)) {
    if (id === fromId) continue;
    const c = centre(b);
    const dx = c.x - o.x;
    const dy = c.y - o.y;
    let ahead: number;
    let side: number;
    switch (dir) {
      case "right":
        ahead = dx;
        side = Math.abs(dy);
        break;
      case "left":
        ahead = -dx;
        side = Math.abs(dy);
        break;
      case "down":
        ahead = dy;
        side = Math.abs(dx);
        break;
      case "up":
        ahead = -dy;
        side = Math.abs(dx);
        break;
    }
    if (ahead <= 0) continue;
    const score = ahead + SIDE_WEIGHT * side;
    if (side <= ahead) {
      if (!cone || score < cone.score) cone = { id, score };
    } else if (!any || score < any.score) {
      any = { id, score };
    }
  }
  return cone?.id ?? any?.id ?? null;
}

/** The box whose centre is closest to the point, or `null` with no boxes. */
export function nearestToPoint(point: Point, boxes: Record<string, Box>): string | null {
  let best: { id: string; d: number } | null = null;
  for (const [id, b] of Object.entries(boxes)) {
    const c = centre(b);
    const d = Math.hypot(c.x - point.x, c.y - point.y);
    if (!best || d < best.d) best = { id, d };
  }
  return best?.id ?? null;
}
