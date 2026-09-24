/**
 * The splitter's arithmetic, apart from the pointer and the DOM: the drag
 * writes its width straight to the pane and the release persists it, and both
 * must read the same number off the same rule.
 */

export type ResizerSide = "left" | "right";

/** Whole pixels inside the pane's range: what the preference stores. */
function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The width under the pointer. A right-edge divider grows as the pointer
 * moves right; a left-edge one, the opposite.
 */
export function dragWidth(drag: {
  side: ResizerSide;
  startX: number;
  startWidth: number;
  clientX: number;
  min: number;
  max: number;
}): number {
  const delta = drag.clientX - drag.startX;
  return clampWidth(
    drag.startWidth + (drag.side === "right" ? delta : -delta),
    drag.min,
    drag.max,
  );
}

/**
 * The width after an arrow key: 16 px a press, 48 with Shift, mirrored on a
 * left edge. `null` for any other key.
 */
export function keyWidth(press: {
  side: ResizerSide;
  width: number;
  key: string;
  shift: boolean;
  min: number;
  max: number;
}): number | null {
  if (press.key !== "ArrowLeft" && press.key !== "ArrowRight") return null;
  const step = (press.shift ? 48 : 16) * (press.key === "ArrowLeft" ? -1 : 1);
  return clampWidth(
    press.width + (press.side === "right" ? step : -step),
    press.min,
    press.max,
  );
}
