/**
 * Keyboard travel between cards: pressing "right" has to land on the card
 * the eye would call "the one to the right", not on the nearest by straight
 * distance (which may sit above) and not on one that is behind the cursor.
 * A wrong pick teaches the user the key is random, and they stop using it.
 */
import { describe, expect, it } from "vitest";

import { nearestInDirection, nearestToPoint } from "./spatialNav";

const box = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });

describe("nearestInDirection", () => {
  it("picks the card straight ahead over a closer one to the side", () => {
    const boxes = {
      me: box(0, 0),
      ahead: box(400, 0),
      side: box(150, 300),
    };
    expect(nearestInDirection("me", boxes, "right")).toBe("ahead");
  });

  it("never goes backwards: nothing to the right of the rightmost card", () => {
    const boxes = { me: box(500, 0), left: box(0, 0), up: box(500, -300) };
    expect(nearestInDirection("me", boxes, "right")).toBeNull();
  });

  it("works on all four directions", () => {
    const boxes = {
      me: box(0, 0),
      r: box(300, 0),
      l: box(-300, 0),
      u: box(0, -300),
      d: box(0, 300),
    };
    expect(nearestInDirection("me", boxes, "right")).toBe("r");
    expect(nearestInDirection("me", boxes, "left")).toBe("l");
    expect(nearestInDirection("me", boxes, "up")).toBe("u");
    expect(nearestInDirection("me", boxes, "down")).toBe("d");
  });

  it("prefers the cone but still finds a card off to the diagonal when the cone is empty", () => {
    const boxes = { me: box(0, 0), diagonal: box(300, 500) };
    expect(nearestInDirection("me", boxes, "right")).toBe("diagonal");
  });

  it("weighs sideways distance twice, so a nearer but offset card loses", () => {
    // Both in the cone: `near` is 200 ahead and 150 off axis (score 500),
    // `far` is 320 ahead and dead centre (score 320).
    const boxes = { me: box(0, 0), near: box(200, 150), far: box(320, 0) };
    expect(nearestInDirection("me", boxes, "right")).toBe("far");
  });

  it("is null for an unknown origin", () => {
    expect(nearestInDirection("ghost", { a: box(0, 0) }, "right")).toBeNull();
  });
});

describe("nearestToPoint", () => {
  it("returns the box whose centre is closest to the point", () => {
    const boxes = { a: box(0, 0), b: box(1000, 1000), c: box(90, 120) };
    expect(nearestToPoint({ x: 150, y: 150 }, boxes)).toBe("c");
  });

  it("is null with nothing to choose from", () => {
    expect(nearestToPoint({ x: 0, y: 0 }, {})).toBeNull();
  });
});
