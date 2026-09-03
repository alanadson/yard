/**
 * Which cards are worth painting. A board with forty terminals has six on
 * screen; the other thirty-four still receive output, but nothing should
 * spend a frame drawing them. The rule has to keep a margin (a pan must not
 * reveal blank cards being mounted) and must never cull before the canvas
 * has a size, or the first frame of every board would be empty.
 */
import { describe, expect, it } from "vitest";

import { largestVisible, visibleIds } from "./culling";

describe("largestVisible", () => {
  const v = { x: 0, y: 0, w: 1000, h: 800 };

  it("picks the box covering the most of the view, counting only the visible part", () => {
    // `big` is mostly off screen: only 100x400 of it shows. `small` shows whole.
    const boxes = { big: { x: 900, y: 0, w: 2000, h: 400 }, small: { x: 100, y: 100, w: 300, h: 300 } };
    expect(largestVisible(boxes, v)).toBe("small");
  });

  it("wants at least one percent of the view, or answers nothing", () => {
    expect(largestVisible({ speck: { x: 10, y: 10, w: 20, h: 20 } }, v)).toBeNull();
    expect(largestVisible({}, v)).toBeNull();
  });

  it("ignores what is entirely off screen", () => {
    expect(largestVisible({ far: { x: 5000, y: 5000, w: 900, h: 900 } }, v)).toBeNull();
  });
});

const view = { x: 1000, y: 1000, w: 1600, h: 900 };
const box = (x: number, y: number, w = 640, h = 400) => ({ x, y, w, h });

describe("visibleIds", () => {
  it("keeps what is on screen and drops what is far away", () => {
    const out = visibleIds({ in: box(1200, 1200), far: box(9000, 9000) }, view, []);
    expect(out.has("in")).toBe(true);
    expect(out.has("far")).toBe(false);
  });

  it("keeps a full screen of margin around the view, so a pan never meets a blank card", () => {
    // One view-width to the right: still painted. Two: not.
    const out = visibleIds({ near: box(2700, 1000), gone: box(4300, 1000) }, view, []);
    expect(out.has("near")).toBe(true);
    expect(out.has("gone")).toBe(false);
  });

  it("a card that merely touches the margin counts", () => {
    // Ends exactly where the margin starts (x = view.x - view.w).
    const out = visibleIds({ edge: box(-1240, 1000) }, view, []);
    expect(out.has("edge")).toBe(true);
  });

  it("whatever the caller asks to keep is kept, wherever it is", () => {
    const out = visibleIds({ far: box(9000, 9000) }, view, ["far"]);
    expect(out.has("far")).toBe(true);
  });

  it("with no view size yet, nothing is culled", () => {
    const out = visibleIds({ a: box(9000, 9000) }, { x: 0, y: 0, w: 0, h: 0 }, []);
    expect(out.has("a")).toBe(true);
  });
});
