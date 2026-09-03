/**
 * Where a new card is offered a place. The offers have to be honest: never on
 * top of something, never on top of each other, always one gap away from a
 * neighbour so the board keeps its rhythm, and the first one is the nearest
 * to where the user pointed. A wrong offer is worse than none, because the
 * user takes it and then drags.
 */
import { describe, expect, it } from "vitest";

import { boxesIntersect } from "./arrange";
import { EMPTY_CANVAS, type Box, type CanvasData } from "./canvas";
import { boardBoxes, freeRects, placementCandidates } from "./placement";

const area: Box = { x: 0, y: 0, w: 2000, h: 1200 };
const size = { w: 400, h: 300 };
const card: Box = { x: 700, y: 400, w: 600, h: 400 };

/** Strict overlap: touching edges are fine. */
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("freeRects", () => {
  it("cuts the area into the four strips around one obstacle", () => {
    const rects = freeRects(area, [card], 10, 10);
    expect(rects).toHaveLength(4);
    for (const r of rects) expect(overlaps(r, card)).toBe(false);
  });

  it("drops strips too small for the thing being placed", () => {
    const rects = freeRects(area, [card], 1500, 10);
    // Only the top and bottom strips are 2000 wide; left (700) and right (700) are not.
    expect(rects).toHaveLength(2);
  });

  it("the whole area with nothing in the way", () => {
    expect(freeRects(area, [], 10, 10)).toEqual([area]);
  });
});

describe("placementCandidates", () => {
  it("an empty board offers the spot under the cursor, and only that", () => {
    const out = placementCandidates({ area, obstacles: [], size, anchor: { x: 800, y: 500 } });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ x: 600, y: 350, w: 400, h: 300 });
  });

  it("keeps the offer inside the area when the cursor sits at the edge", () => {
    const out = placementCandidates({ area, obstacles: [], size, anchor: { x: 1990, y: 1190 } });
    expect(out[0]).toEqual({ x: 1600, y: 900, w: 400, h: 300 });
  });

  it("offers spots one gap away from the card, never on it", () => {
    const gap = 40;
    const out = placementCandidates({ area, obstacles: [card], size, anchor: { x: 1000, y: 600 }, gap });
    expect(out.length).toBeGreaterThan(1);
    const inflated = { x: card.x - gap + 1, y: card.y - gap + 1, w: card.w + 2 * gap - 2, h: card.h + 2 * gap - 2 };
    for (const c of out) expect(overlaps(c, inflated)).toBe(false);
    const right = out.find((c) => c.x === card.x + card.w + gap);
    const left = out.find((c) => c.x + c.w === card.x - gap);
    expect(right).toBeDefined();
    expect(left).toBeDefined();
  });

  it("never offers two spots that overlap", () => {
    const out = placementCandidates({ area, obstacles: [card], size, anchor: { x: 1000, y: 600 }, max: 6 });
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i], out[j]), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it("ranks the nearest to the anchor first", () => {
    const out = placementCandidates({ area, obstacles: [card], size, anchor: { x: 1500, y: 600 } });
    const d = (b: Box) => Math.hypot(b.x + b.w / 2 - 1500, b.y + b.h / 2 - 600);
    for (let i = 1; i < out.length; i++) expect(d(out[i])).toBeGreaterThanOrEqual(d(out[i - 1]));
  });

  it("caps the list", () => {
    const out = placementCandidates({ area, obstacles: [card], size, anchor: { x: 0, y: 0 }, max: 2 });
    expect(out).toHaveLength(2);
  });

  it("offers nothing when nothing fits", () => {
    const out = placementCandidates({ area: { x: 0, y: 0, w: 300, h: 200 }, obstacles: [], size, anchor: { x: 0, y: 0 } });
    expect(out).toEqual([]);
  });

  it("offers are boxes the marquee logic would call separate from the obstacles", () => {
    const out = placementCandidates({ area, obstacles: [card], size, anchor: { x: 100, y: 100 } });
    for (const c of out) expect(boxesIntersect(c, card) && overlaps(c, card)).toBe(false);
  });
});

describe("boardBoxes", () => {
  it("counts the cards and the boxed items, not the wires nor a filed note", () => {
    const c: CanvasData = {
      ...EMPTY_CANVAS,
      nodes: { t1: { x: 0, y: 0, w: 640, h: 400 } },
      items: [
        { id: "n1", type: "note", x: 700, y: 0, w: 200, h: 100, text: "", color: "#fff" },
        { id: "n2", type: "note", x: 5000, y: 5000, w: 200, h: 100, text: "", color: "#fff" },
        { id: "b", type: "binder", x: 700, y: 200, w: 300, h: 200, notes: ["n2"], color: "#fff" },
        { id: "w", type: "connection", from: "t1", to: "n1", color: "#fff" },
      ],
    };
    const boxes = boardBoxes(c);
    expect(boxes).toHaveLength(3);
    expect(boxes.some((b) => b.x === 5000)).toBe(false);
  });
});
