/**
 * Above 100% the world is scaled as a whole, and a terminal drawn at its
 * native atlas turns into blurred bitmaps. The fix is to draw it bigger and
 * shrink it back, in a few discrete steps: every step costs a fresh glyph
 * atlas, so a continuous pinch must not rebuild it sixty times.
 */
import { describe, expect, it } from "vitest";

import { RENDER_SCALE_STEPS, renderScaleFor } from "./renderScale";

describe("renderScaleFor", () => {
  it("is 1 at and below 100%, where a bigger atlas gains nothing", () => {
    expect(renderScaleFor(1)).toBe(1);
    expect(renderScaleFor(0.5)).toBe(1);
    expect(renderScaleFor(0.05)).toBe(1);
  });

  it("snaps to the nearest step above 100%", () => {
    expect(renderScaleFor(1.1)).toBe(1);
    expect(renderScaleFor(1.4)).toBe(1.5);
    expect(renderScaleFor(1.75)).toBe(1.75);
    expect(renderScaleFor(2.2)).toBe(2);
  });

  it("caps at the last step: a 4x zoom is not worth a 4x atlas", () => {
    expect(renderScaleFor(4)).toBe(RENDER_SCALE_STEPS[RENDER_SCALE_STEPS.length - 1]);
  });

  it("tolerates junk", () => {
    expect(renderScaleFor(Number.NaN)).toBe(1);
  });
});
