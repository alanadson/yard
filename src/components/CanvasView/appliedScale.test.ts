/**
 * Every zoom step past 100% changes a terminal's font size, and xterm answers
 * a font change by rebuilding its glyph atlas and resizing its canvases, even
 * for a card that is paused off-screen. With a dozen cards on the board, one
 * wheel notch rebuilt a dozen atlases nobody could see. A card off the board
 * keeps the scale it last drew with and catches up when it comes back.
 */
import { describe, expect, it } from "vitest";

import { appliedScale } from "./appliedScale";

describe("appliedScale", () => {
  it("a visible card follows the zoom's render scale", () => {
    expect(appliedScale(1, 2, true)).toBe(2);
    expect(appliedScale(2, 1.5, true)).toBe(1.5);
  });

  it("a card off the board keeps the scale it last drew with", () => {
    expect(appliedScale(1.5, 2, false)).toBe(1.5);
    expect(appliedScale(2, 1, false)).toBe(2);
  });

  it("a card coming back on the board catches up with the current scale", () => {
    const whileAway = appliedScale(1, 2.5, false);
    expect(appliedScale(whileAway, 2.5, true)).toBe(2.5);
  });
});
