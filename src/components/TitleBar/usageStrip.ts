/**
 * What the usage strip draws on the title bar.
 *
 * A small rule, but with two look-alike outcomes that are easy to mix up: "no
 * data yet" (show the empty gauge, because the data arrives on its own over
 * `usage://update`) and "the user turned the meter off" (show nothing).
 * Swapping one for the other leaves the preference with no visible effect for
 * whoever never connected an account — exactly who went looking for it.
 */
import type { ProviderUsage } from "../../lib/ipc";

export interface UsageStrip {
  /** One chip per provider that has already brought at least one window. */
  chips: ProviderUsage[];
  /** No chip, but the gray gauge in its place: the data is still coming. */
  emptyGauge: boolean;
}

export function buildUsageStrip(
  providers: readonly ProviderUsage[],
  show: boolean,
): UsageStrip {
  if (!show) return { chips: [], emptyGauge: false };
  const chips = providers.filter((p) => p.windows.length > 0);
  return { chips, emptyGauge: chips.length === 0 };
}
