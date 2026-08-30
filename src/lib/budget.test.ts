/**
 * Why these rules matter: "Custos e uso" tells you what you spent *after* you
 * spent it. A budget is the same numbers arriving in time to change what you
 * do, and the two ways to get that wrong are equally bad — a warning that
 * never comes, and a warning that comes back every thirty seconds until it is
 * ignored on principle.
 *
 * There is no clock and no store here: the day's total comes in, the level
 * comes out, and `worsened` is the whole of the "say it once" policy.
 */
import { describe, expect, it } from "vitest";

import { WARN_AT, budgetState, worsened } from "./budget";

describe("budgetState", () => {
  it("is off when no limit was set — most people never set one", () => {
    const state = budgetState(12.5, 0);
    expect(state.level).toBe("off");
    expect(state.pct).toBe(0);
  });

  it("is ok well under the limit", () => {
    expect(budgetState(2, 10).level).toBe("ok");
  });

  it("warns at four fifths, which is where there is still time to act", () => {
    expect(WARN_AT).toBe(0.8);
    expect(budgetState(7.99, 10).level).toBe("ok");
    expect(budgetState(8, 10).level).toBe("warn");
  });

  it("is over at the limit itself, not one cent past it", () => {
    expect(budgetState(10, 10).level).toBe("over");
    expect(budgetState(10.01, 10).level).toBe("over");
  });

  it("reports the percentage for the chip", () => {
    expect(budgetState(5, 10).pct).toBe(50);
    // Past the limit the number keeps going: 140% is the information.
    expect(budgetState(14, 10).pct).toBe(140);
  });

  /**
   * A day with unpriced rows (a model outside the price table) is a **floor**,
   * never a total — the same rule the costs panel follows. Announcing "you are
   * under budget" from a floor would be inventing the missing part as zero.
   */
  it("carries the floor flag through, so the chip can say the sum is partial", () => {
    expect(budgetState(5, 10, false).partial).toBe(true);
    expect(budgetState(5, 10, true).partial).toBe(false);
  });

  it("treats a negative or absurd limit as no limit", () => {
    expect(budgetState(5, -3).level).toBe("off");
  });
});

describe("worsened", () => {
  /** The point of the whole thing: say it when it changes, not on a timer. */
  it("is true only when the level got worse", () => {
    expect(worsened("ok", "warn")).toBe(true);
    expect(worsened("warn", "over")).toBe(true);
    expect(worsened("ok", "over")).toBe(true);
  });

  it("is false when nothing moved", () => {
    expect(worsened("warn", "warn")).toBe(false);
    expect(worsened("over", "over")).toBe(false);
  });

  /**
   * Going down happens at midnight, when the day's spend resets. That is not
   * news, and a balloon saying "you are within budget again" at 00:00 every
   * night is exactly the kind of thing that gets a feature turned off.
   */
  it("is false when it got better", () => {
    expect(worsened("over", "ok")).toBe(false);
    expect(worsened("warn", "ok")).toBe(false);
  });

  it("says nothing about a budget that is off", () => {
    expect(worsened("off", "off")).toBe(false);
    expect(worsened("over", "off")).toBe(false);
    // Setting a limit that is already blown is worth hearing about once.
    expect(worsened("off", "over")).toBe(true);
  });
});
