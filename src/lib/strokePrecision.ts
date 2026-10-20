/**
 * How precisely a finished freehand stroke is kept.
 *
 * The pointer gives world coordinates with every digit a double has, and the
 * board's layout is serialized whole on each save: a tenth of a world pixel
 * is below anything the screen can draw, and costs a fraction of the text.
 * Applied once, when the stroke ends (the draft keeps full precision while
 * the pointer is down).
 */
export function roundStrokePoints(points: readonly number[]): number[] {
  // `|| 0` folds -0 into 0: JSON has no use for a signed zero.
  return points.map((value) => Math.round(value * 10) / 10 || 0);
}
