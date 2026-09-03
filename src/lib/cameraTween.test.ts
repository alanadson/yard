/**
 * The camera glides instead of jumping. The arithmetic has to be frame-rate
 * independent (a 30 Hz laptop and a 144 Hz monitor must arrive at the same
 * time) and has to *finish*: an easing that never snaps leaves the viewport
 * 0.3 px off for ever and the terminal blurry with it.
 */
import { describe, expect, it } from "vitest";

import {
  averageVelocity,
  decayVelocity,
  easeForElapsed,
  inertiaAlive,
  inertiaWorthStarting,
  stepCamera,
  type Camera,
} from "./cameraTween";

describe("easeForElapsed", () => {
  it("covers the configured fraction on one 60 Hz frame", () => {
    expect(easeForElapsed(1000 / 60, 0.18)).toBeCloseTo(0.18, 5);
  });

  it("covers more on a longer frame, never more than everything", () => {
    const frame = 1000 / 60;
    const one = easeForElapsed(frame, 0.18);
    const two = easeForElapsed(2 * frame, 0.18);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeCloseTo(1 - (1 - 0.18) ** 2, 6);
    expect(easeForElapsed(100_000, 0.18)).toBeLessThanOrEqual(1);
  });

  it("covers nothing when no time passed", () => {
    expect(easeForElapsed(0, 0.18)).toBe(0);
  });
});

describe("stepCamera", () => {
  const from: Camera = { x: 0, y: 0, zoom: 1 };
  const to: Camera = { x: 1000, y: 500, zoom: 2 };

  it("moves part of the way on one frame", () => {
    const { camera, done } = stepCamera(from, to, 1000 / 60);
    expect(done).toBe(false);
    expect(camera.x).toBeCloseTo(180, 3);
    expect(camera.y).toBeCloseTo(90, 3);
    // Zoom eases in log space so a 1 -> 2 glide reads as constant speed.
    expect(camera.zoom).toBeCloseTo(2 ** 0.18, 5);
  });

  it("two short frames and one long frame land in the same place", () => {
    const a = stepCamera(stepCamera(from, to, 8).camera, to, 8).camera;
    const b = stepCamera(from, to, 16).camera;
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.zoom).toBeCloseTo(b.zoom, 6);
  });

  it("snaps onto the target once it is within a hair, and says it is done", () => {
    const near: Camera = { x: 999.8, y: 500.1, zoom: 2.0004 };
    const { camera, done } = stepCamera(near, to, 16);
    expect(done).toBe(true);
    expect(camera).toEqual(to);
  });

  it("is done immediately when already there", () => {
    expect(stepCamera(to, to, 16).done).toBe(true);
  });
});

describe("inertia", () => {
  it("averages the last samples inside the window, in px per ms", () => {
    const v = averageVelocity(
      [
        { x: 0, y: 0, t: 0 },
        { x: 10, y: 0, t: 100 },
        { x: 30, y: 10, t: 150 },
        { x: 60, y: 10, t: 200 },
      ],
      100,
    );
    // Only the samples within 100 ms of the last one count: from t=100.
    expect(v).not.toBeNull();
    expect(v!.vx).toBeCloseTo(0.5, 6);
    expect(v!.vy).toBeCloseTo(0.1, 6);
  });

  it("has no opinion with fewer than two samples or no time between them", () => {
    expect(averageVelocity([{ x: 0, y: 0, t: 0 }], 100)).toBeNull();
    expect(
      averageVelocity(
        [
          { x: 0, y: 0, t: 5 },
          { x: 9, y: 9, t: 5 },
        ],
        100,
      ),
    ).toBeNull();
  });

  it("decays per frame regardless of frame length", () => {
    const v = { vx: 1, vy: -1 };
    const one = decayVelocity(decayVelocity(v, 8), 8);
    const two = decayVelocity(v, 16);
    expect(one.vx).toBeCloseTo(two.vx, 6);
    expect(one.vy).toBeCloseTo(two.vy, 6);
    expect(two.vx).toBeLessThan(1);
  });

  it("stops once the movement would be less than half a pixel a frame", () => {
    expect(inertiaAlive({ vx: 0.2, vy: 0 })).toBe(true);
    expect(inertiaAlive({ vx: 0.01, vy: 0.01 })).toBe(false);
  });

  it("only starts from a flick, never from a slow release or from nothing", () => {
    expect(inertiaWorthStarting({ vx: 0.5, vy: 0 })).toBe(true);
    expect(inertiaWorthStarting({ vx: 0.05, vy: 0.05 })).toBe(false);
    expect(inertiaWorthStarting(null)).toBe(false);
  });
});
