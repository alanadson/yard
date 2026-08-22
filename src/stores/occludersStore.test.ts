/**
 * The whole point of this store is that a menu somewhere on the board does
 * *not* touch a portal elsewhere on it — so the intersection test, and the
 * fact that a re-measure to the same place keeps the same object identity,
 * are what is worth pinning down.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { rectsOverlap, useOccluders } from "./occludersStore";

const portal = { x: 100, y: 100, w: 400, h: 300 };

beforeEach(() => {
  useOccluders.setState({ rects: {} });
});

describe("rectsOverlap", () => {
  it("sees a menu dropped on top of the card", () => {
    expect(rectsOverlap(portal, { x: 200, y: 150, w: 180, h: 260 })).toBe(true);
  });

  it("leaves a menu opened elsewhere alone", () => {
    expect(rectsOverlap(portal, { x: 700, y: 100, w: 180, h: 260 })).toBe(false);
    expect(rectsOverlap(portal, { x: 100, y: 700, w: 180, h: 260 })).toBe(false);
  });

  it("counts a menu that only clips the corner", () => {
    expect(rectsOverlap(portal, { x: 480, y: 380, w: 180, h: 260 })).toBe(true);
  });

  it("treats the padding as part of the menu", () => {
    const justOutside = { x: 504, y: 100, w: 180, h: 260 };
    expect(rectsOverlap(portal, justOutside)).toBe(false);
    expect(rectsOverlap(portal, justOutside, 8)).toBe(true);
  });
});

describe("setOccluder", () => {
  it("publishes and retires by key", () => {
    const { setOccluder } = useOccluders.getState();
    setOccluder("menu-1", { x: 0, y: 0, w: 10, h: 10 });
    expect(useOccluders.getState().rects["menu-1"]).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    setOccluder("menu-1", null);
    expect(useOccluders.getState().rects).toEqual({});
  });

  it("keeps the same object when the menu re-measures to the same place", () => {
    const { setOccluder } = useOccluders.getState();
    setOccluder("menu-1", { x: 10, y: 10, w: 100, h: 200 });
    const first = useOccluders.getState().rects;
    setOccluder("menu-1", { x: 10.2, y: 10, w: 100, h: 200 });
    // Identity is the render dependency of every portal on the board: a new
    // object here moves every native surface for nothing.
    expect(useOccluders.getState().rects).toBe(first);
    setOccluder("menu-1", { x: 40, y: 10, w: 100, h: 200 });
    expect(useOccluders.getState().rects).not.toBe(first);
  });

  it("retiring a key nobody published changes nothing", () => {
    const before = useOccluders.getState().rects;
    useOccluders.getState().setOccluder("ghost", null);
    expect(useOccluders.getState().rects).toBe(before);
  });
});
