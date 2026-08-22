/**
 * The numeric field that fights whoever types in it.
 *
 * `onChange={(e) => setEveryMin(Number(e.target.value) || 1)}` — the naive
 * form, which Routines had — does not let you **clear** the field: the
 * instant the content goes empty, `Number("")` is `0`, the `|| 1` puts `1`
 * there, and the next digit piles on top of it. Changing 5 to 60 becomes
 * "clear, watch the 1 appear on its own, fix it". The user's reasonable
 * conclusion is that the field is broken.
 *
 * The right rule, which Preferences already used and Routines did not:
 * **while typing, the text belongs to the user; the number is only decided on
 * leaving.** That leaving is what lives here.
 */
import { describe, expect, it } from "vitest";

import { valueOnBlur } from "./numericField";

/** The clamp of an "every N minutes" field: 1 to 10080. */
const between1And10080 = (n: number) => Math.min(10080, Math.max(1, Math.round(n)));

describe("valorAoSair", () => {
  it("a typed number goes through the clamp", () => {
    expect(valueOnBlur("60", 5, between1And10080)).toBe(60);
  });

  it("above the ceiling, lands on the ceiling — it does not become the old value", () => {
    expect(valueOnBlur("999999", 5, between1And10080)).toBe(10080);
  });

  it("below the floor, lands on the floor", () => {
    expect(valueOnBlur("0", 5, between1And10080)).toBe(1);
  });

  it("an empty field returns the value that already held — clearing is not asking for zero", () => {
    // This is the line that separates the fixed field from the one that
    // fought back: empty is a step *in the middle* of typing, not a value.
    expect(valueOnBlur("", 5, between1And10080)).toBe(5);
    expect(valueOnBlur("   ", 5, between1And10080)).toBe(5);
  });

  it("text that is not a number also returns the old value", () => {
    expect(valueOnBlur("abc", 5, between1And10080)).toBe(5);
    expect(valueOnBlur("-", 5, between1And10080)).toBe(5);
  });

  it("a decimal is rounded by the clamp, not refused", () => {
    expect(valueOnBlur("2.6", 5, between1And10080)).toBe(3);
  });

  it("surrounding whitespace does not get in the way", () => {
    expect(valueOnBlur("  42  ", 5, between1And10080)).toBe(42);
  });
});
