/**
 * The editors published their whole text (`doc.toString()` of the file) to
 * the store on every keystroke, and every subscriber of the store paid for
 * it. The coalescer keeps only the latest value and hands it over once per
 * window; `flush` exists for the moments that cannot wait (a save, the
 * editor losing focus, a shortcut, a file switch, the unmount), so no
 * reader ever sees a keystroke missing.
 */
import { describe, expect, it } from "vitest";

import { createCoalescer } from "./coalesce";

/** A scheduler driven by hand: `fire()` runs what is due. */
function manual() {
  let due: (() => void) | null = null;
  return {
    schedule: (run: () => void) => {
      due = run;
      return () => {
        if (due === run) due = null;
      };
    },
    fire() {
      const run = due;
      due = null;
      run?.();
    },
    get pending() {
      return due !== null;
    },
  };
}

describe("createCoalescer", () => {
  it("publishes only the latest of a burst, once, when its window ends", () => {
    const clock = manual();
    const out: string[] = [];
    const text = createCoalescer<string>((value) => out.push(value), clock.schedule);
    text.push("a");
    text.push("ab");
    text.push("abc");
    expect(out).toEqual([]);
    clock.fire();
    expect(out).toEqual(["abc"]);
  });

  it("flush hands the pending value over at once and leaves nothing for the timer", () => {
    const clock = manual();
    const out: string[] = [];
    const text = createCoalescer<string>((value) => out.push(value), clock.schedule);
    text.push("draft");
    text.flush();
    expect(out).toEqual(["draft"]);
    expect(clock.pending).toBe(false);
    text.flush();
    expect(out).toEqual(["draft"]);
  });

  it("a push after a publish opens a new window", () => {
    const clock = manual();
    const out: string[] = [];
    const text = createCoalescer<string>((value) => out.push(value), clock.schedule);
    text.push("one");
    clock.fire();
    text.push("two");
    clock.fire();
    expect(out).toEqual(["one", "two"]);
  });
});
