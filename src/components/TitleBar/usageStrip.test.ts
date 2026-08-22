/**
 * The usage strip occupies the right side of the title bar the whole time. For
 * whoever has not connected any of the three accounts it shows an empty gauge
 * — chrome asking for room to say nothing — and there was no door to hide it.
 *
 * The preference cannot be "hide the chips and leave the empty gauge in their
 * place": that trades one useless strip for another. Off, the strip goes away
 * entirely and what remains is the energy-drink can, which is another matter
 * and another button.
 */
import { describe, expect, it } from "vitest";

import type { ProviderUsage } from "../../lib/ipc";
import { buildUsageStrip } from "./usageStrip";

const provider = (id: string, windowCount: number): ProviderUsage => ({
  id,
  name: id,
  plan: null,
  account: null,
  windows: Array.from({ length: windowCount }, () => ({
    key: "session",
    usedPercent: 40,
    resetsAt: null,
  })) as ProviderUsage["windows"],
  status: "ok",
  error: null,
  updatedAt: 1,
});

describe("what the title bar strip shows", () => {
  it("with the meter off, neither the chips nor the empty gauge show up", () => {
    const strip = buildUsageStrip([provider("claude", 2)], false);
    expect(strip.chips).toEqual([]);
    expect(strip.emptyGauge).toBe(false);
  });

  it("on and with no data at all, shows the empty gauge — it does not vanish on its own", () => {
    expect(buildUsageStrip([provider("claude", 0)], true)).toEqual({
      chips: [],
      emptyGauge: true,
    });
  });

  it("on, only a provider that has already brought a window gets in", () => {
    const strip = buildUsageStrip([provider("claude", 2), provider("codex", 0)], true);
    expect(strip.chips.map((p) => p.id)).toEqual(["claude"]);
    expect(strip.emptyGauge).toBe(false);
  });
});
