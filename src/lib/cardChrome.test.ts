/**
 * Three things a card's chrome promises: "bring to front" really puts it on
 * top of every other card, a pinned card never moves under a stray drag, and
 * maximize is a round trip that gives back the exact rectangle it took.
 */
import { describe, expect, it } from "vitest";

import { EMPTY_CANVAS, type CanvasData } from "./canvas";
import {
  maximizedRect,
  nodeOrder,
  pinnedIds,
  raiseNode,
  lowerNode,
  setPinned,
  toggleMaximize,
} from "./cardChrome";

const canvas = (): CanvasData => ({
  ...EMPTY_CANVAS,
  nodes: {
    a: { x: 0, y: 0, w: 640, h: 400 },
    b: { x: 100, y: 100, w: 640, h: 400, z: 3 },
    c: { x: 200, y: 200, w: 640, h: 400, z: -1 },
  },
  items: [
    { id: "n1", type: "note", x: 0, y: 0, w: 200, h: 100, text: "", color: "#fff" },
    { id: "p1", type: "portal", x: 0, y: 0, w: 300, h: 200, url: "https://x", color: "#fff" },
  ],
});

describe("z-order of cards", () => {
  it("paints in ascending z, keeping the given order for equal z", () => {
    const c = canvas();
    expect(nodeOrder(["a", "b", "c"], c.nodes)).toEqual(["c", "a", "b"]);
  });

  it("raising puts the card above the highest one", () => {
    const c = raiseNode(canvas(), "a");
    expect(c.nodes.a.z).toBe(4);
    expect(nodeOrder(["a", "b", "c"], c.nodes)).toEqual(["c", "b", "a"]);
  });

  it("lowering puts the card below the lowest one", () => {
    const c = lowerNode(canvas(), "b");
    expect(c.nodes.b.z).toBe(-2);
    expect(nodeOrder(["a", "b", "c"], c.nodes)).toEqual(["b", "c", "a"]);
  });

  it("leaves an unknown card alone", () => {
    const c = canvas();
    expect(raiseNode(c, "zzz")).toBe(c);
  });
});

describe("pinned", () => {
  it("pins a card and an item alike, and lists both", () => {
    let c = setPinned(canvas(), "a", true);
    c = setPinned(c, "n1", true);
    expect(pinnedIds(c)).toEqual(new Set(["a", "n1"]));
    expect(c.nodes.a.pinned).toBe(true);
  });

  it("unpinning drops the field instead of writing false into the JSON", () => {
    const c = setPinned(setPinned(canvas(), "a", true), "a", false);
    expect("pinned" in c.nodes.a).toBe(false);
    expect(pinnedIds(c).size).toBe(0);
  });
});

describe("maximize", () => {
  const view = { x: 1000, y: 500, w: 1600, h: 900 };

  it("fills the visible rectangle with a screen-px margin scaled by the zoom", () => {
    expect(maximizedRect(view, 2, 20)).toEqual({ x: 1010, y: 510, w: 1580, h: 880 });
  });

  it("remembers the old rectangle and gives it back on the second toggle", () => {
    const node = { x: 30, y: 40, w: 640, h: 400, color: "#abc" };
    const big = toggleMaximize(node, view, 1);
    expect(big.restore).toEqual({ x: 30, y: 40, w: 640, h: 400 });
    expect({ x: big.x, y: big.y, w: big.w, h: big.h }).toEqual(maximizedRect(view, 1));
    expect(big.color).toBe("#abc");
    const back = toggleMaximize(big, { ...view, x: 9999 }, 1);
    expect(back).toEqual(node);
    expect("restore" in back).toBe(false);
  });
});
