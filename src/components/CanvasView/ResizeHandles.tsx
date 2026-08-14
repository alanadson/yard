/**
 * The eight resize grips of a canvas box (card, portal, note).
 *
 * Two things make them actually grabbable, and both live in CSS
 * (`--cv-grab`, see styles.css):
 *
 * - **The hit area is compensated for zoom.** The grips live inside
 *   `.cv-world`, which is `scale()`d: a fixed 8px would become 2px of screen
 *   at 25% zoom. `--cv-grab` divides by the current zoom, so the band the
 *   user aims at stays roughly the same on screen at any zoom.
 * - **They hang *outside* the box.** For the portal this is not cosmetic: the
 *   native browser is an OS surface glued on top of `.cv-portal-body`, and any
 *   pixel of grip under it is simply unreachable — which is why resizing a
 *   portal used to only work in the sliver of right edge beside the header.
 */
import { memo } from "react";

import { RESIZE_DIRS, type ResizeDir } from "../../lib/canvas";

interface Props {
  onDown: (e: React.PointerEvent, dir: ResizeDir) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: (e: React.PointerEvent) => void;
  /**
   * Pushes every grip fully outside the box. Required wherever a native
   * surface (portal) covers the interior.
   */
  outside?: boolean;
}

function ResizeHandlesImpl({ onDown, onMove, onUp, outside }: Props) {
  return (
    <>
      {RESIZE_DIRS.map((d) => (
        <div
          key={d}
          className={`cv-resize cv-resize--${d}${outside ? " cv-resize--out" : ""}`}
          onPointerDown={(e) => onDown(e, d)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      ))}
    </>
  );
}

export const ResizeHandles = memo(ResizeHandlesImpl);
