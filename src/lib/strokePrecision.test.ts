/**
 * A freehand stroke is stored as world coordinates straight from the pointer
 * (`12.345678901234`), and the whole layout is serialized on every canvas
 * save: a few long strokes made each save carry kilobytes of digits nobody
 * can see. A tenth of a pixel is below anything the screen can show.
 */
import { describe, expect, it } from "vitest";

import { roundStrokePoints } from "./strokePrecision";

describe("roundStrokePoints", () => {
  it("rounds every coordinate to a tenth of a world pixel", () => {
    expect(roundStrokePoints([1.23456, 2.98765, -0.04999, 100.05001])).toEqual([1.2, 3, 0, 100.1]);
  });

  it("serializes in far fewer characters than the raw pointer samples", () => {
    const raw = Array.from({ length: 200 }, (_, i) => i / 3 + Math.PI);
    expect(JSON.stringify(roundStrokePoints(raw)).length).toBeLessThan(JSON.stringify(raw).length / 2);
  });
});
