/**
 * How a card gesture ends. Two rules the pointer handlers used to spell
 * inline, each in a slightly different way: a `pointercancel` (the window
 * lost the pointer mid-drag) must never commit, and a stationary click on
 * a grip or a header must not cost an undo entry and a workspace rewrite.
 */
import { describe, expect, it } from "vitest";

import { endPhase, rectChanged } from "./gestureEnd";

const box = { x: 10, y: 20, w: 300, h: 200 };

describe("rectChanged", () => {
  it("a rectangle that did not move is unchanged", () => {
    expect(rectChanged(box, { ...box })).toBe(false);
  });

  it("sub-pixel noise below the threshold is unchanged", () => {
    expect(rectChanged(box, { ...box, x: box.x + 0.001 })).toBe(false);
  });

  it("a real move or resize on any side counts", () => {
    expect(rectChanged(box, { ...box, x: 11 })).toBe(true);
    expect(rectChanged(box, { ...box, y: 21 })).toBe(true);
    expect(rectChanged(box, { ...box, w: 301 })).toBe(true);
    expect(rectChanged(box, { ...box, h: 201 })).toBe(true);
  });
});

describe("endPhase", () => {
  it("a pointercancel is a cancel even when the rectangle moved", () => {
    expect(endPhase("pointercancel", true)).toBe("cancel");
  });

  it("a pointerup with a moved rectangle commits", () => {
    expect(endPhase("pointerup", true)).toBe("commit");
  });

  it("a pointerup with nothing moved is a cancel, not a commit", () => {
    expect(endPhase("pointerup", false)).toBe("cancel");
  });
});
