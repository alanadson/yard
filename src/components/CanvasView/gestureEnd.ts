import type { Box } from "../../lib/canvas";

/** Below this, a drag is a click that wobbled. */
const EPSILON = 0.01;

/** Did the gesture actually move or resize the rectangle? */
export function rectChanged(start: Box, end: Box): boolean {
  return (
    Math.abs(end.x - start.x) > EPSILON ||
    Math.abs(end.y - start.y) > EPSILON ||
    Math.abs(end.w - start.w) > EPSILON ||
    Math.abs(end.h - start.h) > EPSILON
  );
}

/**
 * How a pointer gesture ends. A `pointercancel` (the window lost the pointer
 * mid-drag) never commits, and neither does a stationary click: it would
 * cost a useless undo entry and a workspace rewrite.
 */
export function endPhase(eventType: string, changed: boolean): "commit" | "cancel" {
  if (eventType === "pointercancel") return "cancel";
  return changed ? "commit" : "cancel";
}
