/**
 * The maximize button's glyph follows the window: after every resize the bar
 * asks the backend `isMaximized` and swaps "Maximizar" for "Restaurar". A
 * drag on the window's edge fires a resize per mouse move, a hundred a
 * second, and each one was an IPC round trip for an answer that does not
 * change mid-drag. `coalesce` folds a burst into at most one ask per window,
 * with two promises that keep the glyph honest: a lone resize (a click on
 * maximize, a snap) is asked about at once, exactly as before, and the last
 * resize of a burst is always followed by an ask, so the glyph ends right.
 * The clock is injected, so these run in no time and never flake.
 */
import { describe, expect, it } from "vitest";

import { coalesce, type Timer } from "./coalesce";

/** A manual clock: `advance` runs what falls due, in order, and nothing else. */
function manualClock() {
  let now = 0;
  let nextId = 1;
  let queue: { id: number; at: number; run: () => void }[] = [];
  const timer: Timer = {
    set(run, ms) {
      const id = nextId++;
      queue.push({ id, at: now + ms, run });
      return id;
    },
    clear(handle) {
      queue = queue.filter((task) => task.id !== handle);
    },
  };
  return {
    timer,
    get now() {
      return now;
    },
    pending: () => queue.length,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = queue.filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        queue = queue.filter((task) => task !== due);
        now = due.at;
        due.run();
      }
      now = end;
    },
  };
}

function setup(windowMs = 50) {
  const clock = manualClock();
  const asked: number[] = [];
  const gate = coalesce(() => asked.push(clock.now), windowMs, clock.timer);
  return { clock, asked, gate };
}

describe("coalesce: one ask per burst, never a missed last one", () => {
  it("asks at once for a lone resize, as fast as before (a click on maximize)", () => {
    const { asked, gate } = setup();
    gate.poke();
    expect(asked).toEqual([0]);
  });

  it("folds a burst inside the window into one trailing ask at the window's end", () => {
    const { clock, asked, gate } = setup(50);
    gate.poke();
    for (const step of [5, 5, 10, 20]) {
      clock.advance(step);
      gate.poke();
    }
    expect(asked).toEqual([0]);
    clock.advance(50);
    expect(asked).toEqual([0, 50]);
  });

  it("always asks after the last resize of a burst, so the glyph ends on the real state", () => {
    const { clock, asked, gate } = setup(50);
    gate.poke();
    clock.advance(49);
    gate.poke(); // the last one of the drag, 1 ms before the window closes
    clock.advance(1);
    expect(asked).toEqual([0, 50]);
    expect(asked[asked.length - 1]).toBeGreaterThanOrEqual(49);
  });

  it("goes quiet after a window with nothing new, and the next resize is asked at once", () => {
    const { clock, asked, gate } = setup(50);
    gate.poke();
    clock.advance(200);
    expect(asked).toEqual([0]);
    expect(clock.pending()).toBe(0);
    gate.poke();
    expect(asked).toEqual([0, 200]);
  });

  it("a continuous drag is asked about once per window, and never later than a window after a resize", () => {
    const { clock, asked, gate } = setup(50);
    // One second of resizes at 100 Hz, then the hand stops.
    const pokedAt: number[] = [];
    for (let i = 0; i < 100; i++) {
      pokedAt.push(clock.now);
      gate.poke();
      clock.advance(10);
    }
    clock.advance(100);
    // 100 IPC round trips before; one leading ask and one per window after.
    expect(asked.length).toBe(21);
    for (const at of pokedAt) {
      expect(asked.some((a) => a >= at && a <= at + 50)).toBe(true);
    }
  });

  it("drops the pending ask on dispose: an unmounted bar sets no state", () => {
    const { clock, asked, gate } = setup(50);
    gate.poke();
    clock.advance(10);
    gate.poke();
    gate.dispose();
    clock.advance(100);
    expect(asked).toEqual([0]);
    expect(clock.pending()).toBe(0);
    gate.poke();
    expect(asked).toEqual([0]);
  });
});
