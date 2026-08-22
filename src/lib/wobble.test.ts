import { describe, expect, it } from "vitest";

import { connectionGeometry, type CanvasNode } from "./canvas";
import { belly, cablePath, restingSpring, stepSpring } from "./wobble";

const FRAME = 1 / 60;

/** Runs the spring to rest at 60fps and reports what happened on the way. */
function untilStopped(from: [number, number], to: [number, number]) {
  const s = restingSpring(from[0], from[1]);
  let frames = 0;
  let minX = Infinity;
  let maxSlack = 0;
  while (stepSpring(s, to[0], to[1], FRAME)) {
    minX = Math.min(minX, s.x);
    maxSlack = Math.max(maxSlack, Math.hypot(s.x - to[0], s.y - to[1]));
    if (++frames > 600) break; // 10s: the swing must die long before this
  }
  return { frames, minX, maxSlack, final: s };
}

describe("stepSpring", () => {
  it("the swing dissipates and the wire comes to rest in place", () => {
    const { frames, final } = untilStopped([100, 0], [0, 0]);
    expect(frames).toBeLessThan(600);
    // Rest snaps onto the target: the last frame drawn is the geometry.
    expect(final.x).toBe(0);
    expect(final.y).toBe(0);
    expect(final.vx).toBe(0);
  });

  it("dissipates within the time of a gesture: neither instant nor lazy", () => {
    const { frames } = untilStopped([100, 0], [0, 0]);
    expect(frames).toBeGreaterThan(15); // < 0.25s would read as a rigid snap
    expect(frames).toBeLessThan(80); // > 1.3s and it is still wobbling later
  });

  it("overshoots before coming back — it is a swing, not a slide", () => {
    const { minX } = untilStopped([100, 0], [0, 0]);
    expect(minX).toBeLessThan(-5);
  });

  it("a fling does not leave the cable behind in a loop", () => {
    const s = restingSpring(0, 0);
    s.vx = 9000; // card flung across the canvas in one frame
    for (let i = 0; i < 20; i++) stepSpring(s, 0, 0, FRAME);
    expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(120.001);
  });

  it("at rest on the target it does not wake up on its own", () => {
    const s = restingSpring(40, 40);
    expect(stepSpring(s, 40, 40, FRAME)).toBe(false);
  });
});

describe("cablePath", () => {
  const card = (x: number, y: number): CanvasNode => ({ x, y, w: 520, h: 360 });
  const nums = (d: string) => d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g)!.map(Number);

  it("with no slack, it is exactly the `d` of the geometry at rest", () => {
    const g = connectionGeometry(card(0, 0), card(900, 120));
    expect(cablePath(g.cubic, 0, 0)).toBe(g.d);
  });

  it("the belly of the curve lands exactly where the spring is", () => {
    const g = connectionGeometry(card(0, 0), card(900, 0));
    const [bx, by] = belly(g.cubic);
    const bent = nums(cablePath(g.cubic, 30, -45)) as unknown as typeof g.cubic;
    const [nx, ny] = belly(bent);
    expect(nx).toBeCloseTo(bx + 30);
    expect(ny).toBeCloseTo(by - 45);
  });

  it("the ends do not move: the cable stays plugged into both cards", () => {
    const g = connectionGeometry(card(0, 0), card(900, 0));
    const bent = nums(cablePath(g.cubic, 80, 80));
    expect(bent[0]).toBe(g.cubic[0]);
    expect(bent[1]).toBe(g.cubic[1]);
    expect(bent[6]).toBe(g.cubic[6]);
    expect(bent[7]).toBe(g.cubic[7]);
  });
});
