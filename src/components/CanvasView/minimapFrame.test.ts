/**
 * The minimap re-renders on every frame of a pan, because the camera box on
 * it moves. The card rectangles under that box must not: they only move when
 * the frame of the map itself moves, which happens when a card moves or the
 * camera leaves the board. These tests pin that the frame is a function of
 * the board's bounds (walked once per change of the boxes) plus the camera
 * only where the camera sticks out, so a pan inside the board leaves every
 * card rectangle exactly where it was.
 */
import { describe, expect, it } from "vitest";

import { contentBounds, mapFrame } from "./minimapFrame";

const MAP = { w: 188, h: 118 };
const board = [
  { x: 0, y: 0, w: 400, h: 300 },
  { x: 600, y: 200, w: 400, h: 300 },
];

describe("contentBounds", () => {
  it("covers every box on the board", () => {
    expect(contentBounds(board)).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 500 });
  });

  it("an empty board has no bounds", () => {
    expect(contentBounds([])).toBeNull();
  });
});

describe("mapFrame", () => {
  it("panning inside the board leaves the map exactly where it was", () => {
    const content = contentBounds(board);
    const here = mapFrame(content, { x: 100, y: 50, w: 300, h: 200 }, MAP);
    const there = mapFrame(content, { x: 500, y: 250, w: 300, h: 200 }, MAP);
    expect(there).toEqual(here);
  });

  it("pads the board and centers it inside the little box", () => {
    const frame = mapFrame(contentBounds(board), { x: 100, y: 50, w: 300, h: 200 }, MAP);
    // 1000 x 500 plus 6% on each side: 1120 x 560, limited by the width.
    expect(frame.minX).toBeCloseTo(-60);
    expect(frame.minY).toBeCloseTo(-30);
    expect(frame.scale).toBeCloseTo(188 / 1120);
    expect(frame.offX).toBeCloseTo(0);
    expect(frame.offY).toBeCloseTo((118 - 560 * (188 / 1120)) / 2);
  });

  it("a camera panned into empty space stretches the map so its box stays on it", () => {
    const cam = { x: 3000, y: 2000, w: 300, h: 200 };
    const frame = mapFrame(contentBounds(board), cam, MAP);
    const right = frame.offX + (cam.x + cam.w - frame.minX) * frame.scale;
    const bottom = frame.offY + (cam.y + cam.h - frame.minY) * frame.scale;
    expect(right).toBeLessThanOrEqual(MAP.w);
    expect(bottom).toBeLessThanOrEqual(MAP.h);
    expect(frame.minX).toBeLessThanOrEqual(0);
  });

  it("an empty board frames the camera alone", () => {
    const cam = { x: 50, y: 50, w: 400, h: 250 };
    const frame = mapFrame(null, cam, MAP);
    expect(frame.minX).toBeLessThan(cam.x);
    expect(frame.offX + (cam.x + cam.w - frame.minX) * frame.scale).toBeLessThanOrEqual(MAP.w);
  });
});
