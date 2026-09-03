/**
 * The arrangement math is the half of multi-selection nobody sees failing:
 * a distribute that is off by a few px still *looks* arranged, and a snap
 * that grabs the wrong edge only shows up as a card that will not sit still.
 */
import { describe, expect, it } from "vitest";

import {
  alignBoxes,
  boxesIntersect,
  distributeBoxes,
  snapBoxToGrid,
  snapMove,
  snapResize,
  snapResizeToGrid,
  snapToGrid,
  tidyBoxes,
  unionBox,
} from "./arrange";

describe("snapToGrid", () => {
  it("rounds to the nearest grid line, either way", () => {
    expect(snapToGrid(31, 26)).toBe(26);
    expect(snapToGrid(40, 26)).toBe(52);
    expect(snapToGrid(-10, 26)).toBe(-0 + 0);
  });

  it("snaps a box's origin and leaves its size alone when only moving", () => {
    expect(snapBoxToGrid({ x: 31, y: 66, w: 111, h: 77 }, 26, "move")).toEqual({
      x: 26,
      y: 78,
      w: 111,
      h: 77,
    });
  });

  it("snaps the far edges when resizing, keeping the origin", () => {
    // Right edge 31 + 111 = 142 -> 130; bottom 66 + 77 = 143 -> 156.
    expect(snapBoxToGrid({ x: 31, y: 66, w: 111, h: 77 }, 26, "resize")).toEqual({
      x: 31,
      y: 66,
      w: 99,
      h: 90,
    });
  });

  it("a resize snaps only the edges the hand moved, so the still side never twitches", () => {
    const base = { x: 52, y: 52, w: 104, h: 104 };
    // The west edge was pulled from 52 to 41: it lands on 52 again and the
    // east edge (156) does not move at all.
    expect(snapResizeToGrid({ x: 41, y: 52, w: 115, h: 104 }, base, 26)).toEqual(base);
    // The east edge was pulled to 171 -> 182; nothing else moves.
    expect(snapResizeToGrid({ x: 52, y: 52, w: 119, h: 104 }, base, 26)).toEqual({
      x: 52,
      y: 52,
      w: 130,
      h: 104,
    });
  });

  it("never snaps a box below a size of one cell", () => {
    expect(snapBoxToGrid({ x: 0, y: 0, w: 5, h: 5 }, 26, "resize")).toEqual({
      x: 0,
      y: 0,
      w: 26,
      h: 26,
    });
  });
});

const box = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });

describe("unionBox", () => {
  it("covers every rectangle", () => {
    expect(unionBox({ a: box(0, 0), b: box(150, 50, 50, 200) })).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 250,
    });
  });

  it("returns null with nothing in it", () => {
    expect(unionBox({})).toBeNull();
  });
});

describe("boxesIntersect", () => {
  it("accepts touching boxes and rejects separated ones", () => {
    expect(boxesIntersect(box(0, 0), box(100, 0))).toBe(true);
    expect(boxesIntersect(box(0, 0), box(101, 0))).toBe(false);
  });
});

describe("alignBoxes", () => {
  it("aligns to the union's edge, not to the first box", () => {
    const boxes = { a: box(0, 0, 100, 100), b: box(40, 200, 300, 50) };
    expect(alignBoxes(boxes, "left")).toEqual({ b: { x: 0, y: 200 } });
  });

  it("centers each box by its own size", () => {
    const boxes = { a: box(0, 0, 100, 100), b: box(0, 200, 300, 50) };
    // union: x 0..300, center 150 — the 100-wide box moves to 100.
    expect(alignBoxes(boxes, "hcenter").a).toEqual({ x: 100, y: 0 });
  });

  it("does not return boxes already in place", () => {
    const boxes = { a: box(0, 0), b: box(0, 200) };
    expect(alignBoxes(boxes, "left")).toEqual({});
  });
});

describe("distributeBoxes", () => {
  it("equalizes the gaps, not the centers", () => {
    // widths 100 / 300 / 100 between x=0 and x=1000: 500 left over in 2 gaps = 250.
    const boxes = { a: box(0, 0, 100), b: box(400, 0, 300), c: box(900, 0, 100) };
    const m = distributeBoxes(boxes, "h");
    expect(m.b).toEqual({ x: 350, y: 0 });
    expect(m.a).toBeUndefined();
    expect(m.c).toBeUndefined();
  });

  it("ignores selections with fewer than three", () => {
    expect(distributeBoxes({ a: box(0, 0), b: box(500, 0) }, "h")).toEqual({});
  });

  it("distributes vertically using the heights", () => {
    const boxes = {
      a: box(0, 0, 10, 100),
      b: box(0, 130, 10, 100),
      c: box(0, 600, 10, 100),
    };
    const m = distributeBoxes(boxes, "v");
    expect(m.b).toEqual({ x: 0, y: 300 });
  });
});

describe("tidyBoxes", () => {
  it("builds a grid from the union's corner", () => {
    const boxes = {
      a: box(10, 10, 100, 100),
      b: box(500, 12, 60, 40),
      c: box(9, 400, 100, 100),
      d: box(700, 402, 100, 100),
    };
    const m = tidyBoxes(boxes, "grid", 20);
    // cell = widest width (100) x tallest height (100), origin (9, 10).
    expect(m.a).toEqual({ x: 9, y: 10 });
    expect(m.b).toEqual({ x: 129, y: 10 });
    expect(m.c).toEqual({ x: 9, y: 130 });
    expect(m.d).toEqual({ x: 129, y: 130 });
  });

  it("preserves reading order when lining up in a row", () => {
    const boxes = { right: box(300, 0), left: box(0, 5) };
    const m = tidyBoxes(boxes, "row", 10);
    expect(m.left.x).toBeLessThan(m.right.x);
  });

  it("stacks into a column", () => {
    const boxes = { a: box(0, 0), b: box(300, 0), c: box(600, 0) };
    const m = tidyBoxes(boxes, "column", 10);
    expect(m.a).toBeUndefined(); // already at the union's corner
    expect(m.b).toEqual({ x: 0, y: 110 });
    expect(m.c).toEqual({ x: 0, y: 220 });
  });
});

describe("snapMove", () => {
  it("snaps the left edge to the neighbor's", () => {
    const s = snapMove(box(103, 400), [box(100, 0)], 8);
    expect(s.dx).toBe(-3);
    expect(s.dy).toBe(0);
    expect(s.guides).toHaveLength(1);
    expect(s.guides[0]).toMatchObject({ axis: "x", at: 100 });
  });

  it("stretches the guide from the target's top to the dragged box's bottom", () => {
    const s = snapMove(box(103, 400), [box(100, 0)], 8);
    expect(s.guides[0].from).toBe(0);
    expect(s.guides[0].to).toBe(500);
  });

  it("aligns center to center when no edge is within reach", () => {
    // target: edges at 100/200, center at 150. The 50-wide box centers at 148:
    // far from both edges, two px from the center.
    const s = snapMove(box(123, 400, 50, 50), [box(100, 0)], 8);
    expect(s.dx).toBe(2);
    expect(s.guides[0]).toMatchObject({ axis: "x", at: 150 });
  });

  it("does not invent a magnet outside the tolerance", () => {
    expect(snapMove(box(140, 400), [box(100, 0)], 8)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });

  it("merges every target on the same line into a single guide", () => {
    const s = snapMove(box(103, 900), [box(100, 0), box(100, 300), box(100, 600)], 8);
    expect(s.guides).toHaveLength(1);
    expect(s.guides[0].from).toBe(0);
    expect(s.guides[0].to).toBe(1000);
  });
});

describe("snapResize", () => {
  const base = box(0, 0, 100, 100);

  it("snaps only the edge that moved", () => {
    const r = snapResize(box(0, 0, 197, 100), base, [box(200, 300)], 8, 10, 10);
    expect(r.rect).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it("pulling the west edge keeps the east edge still", () => {
    const r = snapResize(box(-3, 0, 103, 100), base, [box(-40, 300, 40, 40)], 8, 10, 10);
    expect(r.rect.x).toBe(0); // the target's right edge
    expect(r.rect.x + r.rect.w).toBe(100);
  });

  it("respects the minimum size", () => {
    // the target's right edge is at 6, but shrinking that far would break the minimum.
    const r = snapResize(box(0, 0, 12, 100), base, [box(4, 300, 2, 2)], 8, 10, 10);
    expect(r.rect.w).toBe(10);
  });

  it("returns the rectangle untouched when there are no targets", () => {
    const r = snapResize(box(0, 0, 197, 100), base, [], 8, 10, 10);
    expect(r.rect).toEqual(box(0, 0, 197, 100));
    expect(r.guides).toEqual([]);
  });
});
