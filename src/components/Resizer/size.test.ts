/**
 * The splitter's arithmetic. The drag now writes the pane's width straight to
 * the DOM and only reaches the store on release, so the number the pointer
 * produces and the number that gets persisted must come from the same rule:
 * the same clamp, the same rounding, the same direction per side.
 */
import { describe, expect, it } from "vitest";

import { dragWidth, keyWidth } from "./size";

describe("dragWidth", () => {
  const drag = { startX: 500, startWidth: 300, min: 200, max: 400 };

  it("grows a right-edge divider as the pointer moves right", () => {
    expect(dragWidth({ ...drag, side: "right", clientX: 540 })).toBe(340);
  });

  it("grows a left-edge divider as the pointer moves left", () => {
    expect(dragWidth({ ...drag, side: "left", clientX: 460 })).toBe(340);
  });

  it("stops at the pane's floor and ceiling", () => {
    expect(dragWidth({ ...drag, side: "right", clientX: 0 })).toBe(200);
    expect(dragWidth({ ...drag, side: "right", clientX: 5000 })).toBe(400);
  });

  it("lands on whole pixels, the value the preference stores", () => {
    expect(dragWidth({ ...drag, side: "right", clientX: 512.6 })).toBe(313);
  });
});

describe("keyWidth", () => {
  const at = { width: 300, min: 200, max: 400 };

  it("moves 16 px per arrow, 48 with Shift, in the direction of the arrow on a right edge", () => {
    expect(keyWidth({ ...at, side: "right", key: "ArrowRight", shift: false })).toBe(316);
    expect(keyWidth({ ...at, side: "right", key: "ArrowLeft", shift: true })).toBe(252);
  });

  it("mirrors the arrows on a left edge, where the pane grows leftwards", () => {
    expect(keyWidth({ ...at, side: "left", key: "ArrowLeft", shift: false })).toBe(316);
  });

  it("stops at the pane's floor and ceiling", () => {
    expect(keyWidth({ ...at, width: 390, side: "right", key: "ArrowRight", shift: true })).toBe(400);
  });

  it("has nothing to say about any other key", () => {
    expect(keyWidth({ ...at, side: "right", key: "Enter", shift: false })).toBeNull();
  });
});
