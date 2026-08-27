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

/** The part of a DOMRect the popover needs: two edges, in viewport pixels. */
export interface ChipRect {
  top: number;
  bottom: number;
  right: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Where to pin the popover, in the same edges the CSS uses. */
export interface PopAnchor {
  /** Distance from the window's bottom edge to the popover's bottom. */
  bottom: number;
  /** Distance from the window's right edge to the popover's right. */
  right: number;
}

/** The gap between the chip and the panel it opens. */
const GAP = 6;

/** No panel touches the window's edge. */
const MARGIN = 8;

/**
 * The popover grows **upward** from the chip: in the footer there is no room
 * below, and a panel anchored by its top would be drawn past the bottom edge.
 * Pinning it by the bottom also means the panel grows away from the bar as it
 * gets taller, instead of walking off the screen.
 */
export function popAnchor(chip: ChipRect, viewport: Viewport): PopAnchor {
  return {
    bottom: viewport.height - chip.top + GAP,
    right: Math.max(MARGIN, viewport.width - chip.right),
  };
}
