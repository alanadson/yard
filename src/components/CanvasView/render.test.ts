// Resizing a committed stroke must invalidate its cached outline even when its first point stays fixed.
import { describe, expect, it } from "vitest";
import type { CanvasItem } from "../../lib/canvas";
import { resizeVectorItem } from "../../lib/itemSizing";
import { freehandPath, freehandPathCached } from "./render";

describe("cached stroke outlines", () => {
  it("redraws a resized stroke whose first point and point count stay unchanged", () => {
    const stroke: Extract<CanvasItem, { type: "stroke" }> = {
      id: "resized-stroke", type: "stroke", color: "#000000", size: "m",
      points: [0, 0, 10, 10, 20, 20],
    };
    const original = freehandPathCached(stroke);
    const resized = resizeVectorItem(stroke, "se", 20, 20);
    if (resized.type !== "stroke") throw new Error("Expected a stroke");

    expect(freehandPathCached(resized)).toBe(freehandPath(resized.points, resized.size));
    expect(freehandPathCached(resized)).not.toBe(original);
  });
});
