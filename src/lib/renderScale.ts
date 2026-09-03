/**
 * How much bigger a terminal draws itself when the camera is past 100%.
 *
 * The world is scaled as a whole (`transform: scale`), so at 200% a glyph
 * atlas rendered for 13px is stretched to 26px and blurs. Drawing the
 * terminal at 26px and shrinking it back by half keeps it crisp, and keeps
 * its columns and rows exactly where they were. Each step costs a fresh
 * atlas, which is why the scale snaps to a few values instead of following
 * the zoom: a continuous pinch must not rebuild it sixty times.
 */

export const RENDER_SCALE_STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5] as const;

/** The nearest step for a zoom; 1 at and below 100%, where nothing is gained. */
export function renderScaleFor(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 1) return 1;
  let best: number = RENDER_SCALE_STEPS[0];
  let bestDistance = Infinity;
  for (const step of RENDER_SCALE_STEPS) {
    const d = Math.abs(step - zoom);
    if (d < bestDistance) {
      bestDistance = d;
      best = step;
    }
  }
  return best;
}
