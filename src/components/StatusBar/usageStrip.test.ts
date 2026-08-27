/**
 * The usage strip lives in the status bar, the window's footer. For whoever
 * has not connected any of the three accounts it shows an empty gauge, chrome
 * asking for room to say nothing, and there was no door to hide it.
 *
 * The preference cannot be "hide the chips and leave the empty gauge in their
 * place": that trades one useless strip for another. Off, the strip goes away
 * entirely and what remains is the energy-drink can, which is another matter
 * and another button.
 */
import { describe, expect, it } from "vitest";

import type { ProviderUsage } from "../../lib/ipc";
import { buildUsageStrip, popAnchor } from "./usageStrip";

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

/**
 * Where the popover opens. In the title bar it hung *below* the chip, which
 * is the one direction that does not exist in a footer: anchored by its top,
 * a panel opened from the last row of the window would be drawn past the
 * bottom edge and read as a sliver. Down here it is anchored by the bottom,
 * and both of its distances are measured from the edges the CSS uses
 * (`bottom` and `right`), never from the chip's own corner.
 */
describe("where the usage popover opens", () => {
  const viewport = { width: 1000, height: 700 };
  const chip = { top: 672, bottom: 694, right: 940 };

  it("opens upward: it grows away from the footer, not past the screen edge", () => {
    const at = popAnchor(chip, viewport);
    expect(at.bottom).toBe(700 - 672 + 6);
  });

  it("hangs from the chip's right edge, in distance from the window's right", () => {
    expect(popAnchor(chip, viewport).right).toBe(1000 - 940);
  });

  it("never leaves the window: a chip at the very edge keeps the 8px margin", () => {
    const atEdge = popAnchor({ top: 672, bottom: 694, right: 998 }, viewport);
    expect(atEdge.right).toBe(8);
  });
});
