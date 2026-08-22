/**
 * "Where does it land" is invisible when it works and infuriating when it
 * does not: a card placed off the visible rectangle looks like a creation
 * that failed, and a pile of three cards on one spot looks like one card.
 */
import { describe, expect, it } from "vitest";

import {
  dropAt,
  dropPointFor,
  registerDropCamera,
  unstack,
  type DropCamera,
} from "./dropPoint";

const cam = (
  cursor: { x: number; y: number } | null,
  view = { x: 0, y: 0, w: 1000, h: 800 },
): DropCamera => ({ view, cursor });

describe("dropAt", () => {
  it("puts the corner on the cursor", () => {
    expect(dropAt(cam({ x: 300, y: 200 }), { w: 200, h: 100 })).toEqual({
      x: 300,
      y: 200,
    });
  });

  it("centers in the view when there is no cursor", () => {
    expect(dropAt(cam(null), { w: 200, h: 100 })).toEqual({ x: 400, y: 350 });
  });

  it("reads the camera, not the origin: a panned view centers on itself", () => {
    const view = { x: 5000, y: 2000, w: 1000, h: 800 };
    expect(dropAt(cam(null, view), { w: 200, h: 100 })).toEqual({
      x: 5400,
      y: 2350,
    });
  });

  it("pulls a box clicked near the edge back into view", () => {
    expect(dropAt(cam({ x: 980, y: 780 }), { w: 200, h: 100 })).toEqual({
      x: 800,
      y: 700,
    });
  });

  it("keeps a box bigger than the view at the top-left corner", () => {
    expect(dropAt(cam({ x: 600, y: 400 }), { w: 4000, h: 3000 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("without a size, the point is the point", () => {
    expect(dropAt(cam({ x: 999, y: 799 }))).toEqual({ x: 999, y: 799 });
  });
});

describe("unstack", () => {
  it("leaves a free spot alone", () => {
    expect(unstack({ x: 100, y: 100 }, [{ x: 400, y: 400 }])).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("cascades off a taken one, and off the cascade too", () => {
    const taken = [
      { x: 100, y: 100 },
      { x: 128, y: 128 },
    ];
    expect(unstack({ x: 100, y: 100 }, taken)).toEqual({ x: 156, y: 156 });
  });

  it("counts a corner a hair away as the same spot", () => {
    expect(unstack({ x: 100, y: 100 }, [{ x: 100.5, y: 99.7 }])).toEqual({
      x: 128,
      y: 128,
    });
  });

  it("gives up instead of looping when everything is taken", () => {
    const wall = Array.from({ length: 40 }, (_, i) => ({
      x: 100 + i * 28,
      y: 100 + i * 28,
    }));
    expect(unstack({ x: 100, y: 100 }, wall)).toEqual({ x: 436, y: 436 });
  });
});

describe("registerDropCamera", () => {
  it("answers for the group that registered, and nobody else", () => {
    const off = registerDropCamera("g1", () => cam({ x: 10, y: 20 }));
    expect(dropPointFor("g1")).toEqual({ x: 10, y: 20 });
    expect(dropPointFor("g2")).toBeNull();
    expect(dropPointFor(null)).toBeNull();
    off();
  });

  it("stops answering once unregistered — a stale camera is worse than none", () => {
    const off = registerDropCamera("g3", () => cam({ x: 10, y: 20 }));
    off();
    expect(dropPointFor("g3")).toBeNull();
  });

  it("a canvas with no element on screen yet has no answer", () => {
    const off = registerDropCamera("g4", () => null);
    expect(dropPointFor("g4")).toBeNull();
    off();
  });

  it("unregistering the previous reader does not silence the current one", () => {
    // Remount order in React: the new view registers before the old one's
    // cleanup runs. A blind `delete` there would leave the live canvas mute.
    const off1 = registerDropCamera("g5", () => cam({ x: 1, y: 1 }));
    const off2 = registerDropCamera("g5", () => cam({ x: 2, y: 2 }));
    off1();
    expect(dropPointFor("g5")).toEqual({ x: 2, y: 2 });
    off2();
  });
});
