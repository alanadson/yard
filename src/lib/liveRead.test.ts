/**
 * The native mirrors (flow runs, checkpoint notices, the queue, routine runs)
 * used to be read on a 2 s timer that never stopped, even with the window in
 * the tray. The backend now announces each change, so a read happens when it
 * says so, once at start (a reload must see the present), once when the
 * window comes back (events may have been missed while nobody looked), and on
 * a slow safety tick that only runs while somebody can see the result.
 */
import { describe, expect, it } from "vitest";

import { startLiveRead, type Visibility } from "./liveRead";

/** A hand-driven world: events, the window and the timer fire when told. */
function harness(initialShown = true) {
  let shown = initialShown;
  const shownListeners = new Set<(shown: boolean) => void>();
  const eventListeners = new Set<() => void>();
  const ticks = new Set<() => void>();
  let reads = 0;
  let pending: (() => void) | null = null;
  let hold = false;
  const visibility: Visibility = {
    get: () => shown,
    subscribe(listener) {
      shownListeners.add(listener);
      return () => shownListeners.delete(listener);
    },
  };
  return {
    get reads() {
      return reads;
    },
    /** From now on each read waits for `finish()`. */
    holdReads() {
      hold = true;
    },
    finish() {
      const done = pending;
      pending = null;
      done?.();
    },
    read: () => {
      reads += 1;
      if (!hold) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending = resolve;
      });
    },
    event: (cb: () => void) => {
      eventListeners.add(cb);
      return Promise.resolve(() => {
        eventListeners.delete(cb);
      });
    },
    emit() {
      for (const cb of [...eventListeners]) cb();
    },
    get listening() {
      return eventListeners.size;
    },
    visibility,
    setShown(next: boolean) {
      shown = next;
      for (const listener of [...shownListeners]) listener(next);
    },
    every: (tick: () => void) => {
      ticks.add(tick);
      return () => {
        ticks.delete(tick);
      };
    },
    tick() {
      for (const tick of [...ticks]) tick();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("startLiveRead", () => {
  it("reads once at start, so a reloaded page sees the present before any event", async () => {
    const h = harness();
    startLiveRead({ read: h.read, events: [h.event], visibility: h.visibility, every: h.every, fallbackMs: 30_000 });
    await settle();
    expect(h.reads).toBe(1);
  });

  it("reads again each time the backend announces a change", async () => {
    const h = harness();
    startLiveRead({ read: h.read, events: [h.event], visibility: h.visibility, every: h.every, fallbackMs: 30_000 });
    await settle();
    h.emit();
    await settle();
    h.emit();
    await settle();
    expect(h.reads).toBe(3);
  });

  it("answers announcements made during a read with one more read after it, not one per event", async () => {
    const h = harness();
    h.holdReads();
    startLiveRead({ read: h.read, events: [h.event], visibility: h.visibility, every: h.every, fallbackMs: 30_000 });
    await settle();
    h.emit();
    h.emit();
    h.emit();
    expect(h.reads).toBe(1);
    h.finish();
    await settle();
    // The change announced mid-read may not be in the answer that was already
    // on its way: exactly one more read covers all three announcements.
    expect(h.reads).toBe(2);
    h.finish();
    await settle();
    expect(h.reads).toBe(2);
  });

  it("the safety tick reads while the window is shown and asks nothing while it is hidden", async () => {
    const h = harness();
    startLiveRead({ read: h.read, events: [h.event], visibility: h.visibility, every: h.every, fallbackMs: 30_000 });
    await settle();
    h.tick();
    await settle();
    expect(h.reads).toBe(2);
    h.setShown(false);
    h.tick();
    h.tick();
    await settle();
    expect(h.reads).toBe(2);
  });

  it("catches up with one read when the window comes back, and none when it goes away", async () => {
    const h = harness(false);
    startLiveRead({ read: h.read, events: [h.event], visibility: h.visibility, every: h.every, fallbackMs: 30_000 });
    await settle();
    expect(h.reads).toBe(1);
    h.setShown(true);
    await settle();
    expect(h.reads).toBe(2);
    h.setShown(false);
    await settle();
    expect(h.reads).toBe(2);
  });

  it("after stop, no event, tick or return of the window reads again, and the listeners are gone", async () => {
    const h = harness();
    const stop = startLiveRead({ read: h.read, events: [h.event], visibility: h.visibility, every: h.every, fallbackMs: 30_000 });
    await settle();
    stop();
    h.emit();
    h.tick();
    h.setShown(false);
    h.setShown(true);
    await settle();
    expect(h.reads).toBe(1);
    expect(h.listening).toBe(0);
  });

  it("releases a listener whose subscription only lands after stop", async () => {
    const h = harness();
    let release: (() => void) | null = null;
    let released = false;
    const slow = (cb: () => void) =>
      new Promise<() => void>((resolve) => {
        release = () => resolve(() => { released = true; void cb; });
      });
    const stop = startLiveRead({ read: h.read, events: [slow], visibility: h.visibility, every: h.every, fallbackMs: 30_000 });
    stop();
    release!();
    await settle();
    expect(released).toBe(true);
  });

  it("reports a failed read and still reads on the next announcement", async () => {
    const h = harness();
    const errors: unknown[] = [];
    let fail = true;
    const read = () => {
      void h.read();
      return fail ? Promise.reject(new Error("backend away")) : Promise.resolve();
    };
    startLiveRead({ read, events: [h.event], visibility: h.visibility, every: h.every, fallbackMs: 30_000, onError: (e) => errors.push(e) });
    await settle();
    fail = false;
    h.emit();
    await settle();
    expect(errors).toHaveLength(1);
    expect(h.reads).toBe(2);
  });
});
