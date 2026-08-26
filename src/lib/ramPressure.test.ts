/**
 * "Is the machine running out of memory?" was answered inline by the sidebar
 * HUD, with two thresholds nobody else could reuse. The status bar needs the
 * same reading, and two copies of 0.82/0.92 would drift the first time one of
 * them was tuned — the bar would go yellow while the HUD stayed blue. So the
 * reading lives once: the share of RAM in use and the level that colours it.
 */
import { describe, expect, it } from "vitest";

import { ramPressure } from "./ramPressure";

describe("ramPressure", () => {
  it("unknown total (before the first resources tick): no reading, not a fake zero", () => {
    expect(ramPressure(0, 0)).toBeNull();
    expect(ramPressure(1_000, 0)).toBeNull();
  });

  it("usage is the share in use, with a whole percent for the label", () => {
    expect(ramPressure(8_000, 32_000)).toEqual({ usage: 0.75, pct: 75, level: "ok" });
  });

  it("warns above 82% and turns critical above 92% — the sidebar HUD's thresholds", () => {
    expect(ramPressure(6_000, 32_000)?.level).toBe("ok"); // 81%
    expect(ramPressure(5_000, 32_000)?.level).toBe("warn"); // 84%
    expect(ramPressure(2_000, 32_000)?.level).toBe("crit"); // 94%
  });

  it("a backend reporting more available than total cannot push usage below zero", () => {
    expect(ramPressure(40_000, 32_000)).toEqual({ usage: 0, pct: 0, level: "ok" });
  });
});
