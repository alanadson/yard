/**
 * How a pane hides the terminals that are not the active tab.
 *
 * Hidden tabs stay mounted (that is what keeps the attach stable), so the
 * inactive panels have to be hidden from assistive tech explicitly:
 * `visibility: hidden` does that for the eye, but `aria-hidden` is what does
 * it for a screen reader.
 *
 * `visibility` and not `display: none`: the host keeps its real size even when
 * hidden, so the back-tab xterm can measure font/cell and fit works. With
 * display none the renderer opens in a 0x0 host and explodes from the inside
 * ("reading 'dimensions'") on the first write.
 *
 * And out of the viewport, at that same size: xterm pauses its renderer only
 * through an IntersectionObserver, which ignores `visibility`, so a panel
 * hidden in place kept repainting every chunk of output its CLI printed. A
 * transform moves the box without touching its layout (the size, the fit and
 * the ResizeObserver see nothing), and `.pane`'s `overflow: hidden` clips
 * what it moved. Two screen widths is far enough for any pane, wherever it
 * sits. The observer alone would report the way back only after the reveal
 * frame is painted, and the tab that comes back would show the screen it left
 * with first (measured in Edge): `XTermView`'s `resumeOnShow`, which the pane
 * passes, repaints it inside that frame instead.
 */
import type { CSSProperties } from "react";

export interface PanelHiding {
  "aria-hidden": boolean;
  style: CSSProperties;
}

export function terminalPanelProps(visible: boolean): PanelHiding {
  return {
    "aria-hidden": !visible,
    style: visible
      ? { visibility: "visible" }
      : { visibility: "hidden", transform: "translateX(-200vw)" },
  };
}
