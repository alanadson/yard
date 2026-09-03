/**
 * The runners-up of a guided placement: dashed rectangles, numbered, drawn
 * in world space right after a card was born (`lib/placement.ts`).
 *
 * They are an offer, not a mode: the board stays fully interactive around
 * them, a number key or a click takes one, and anything else dismisses them.
 * The badge counter-scales with the zoom so it reads the same at 30% and at
 * 200%, which is the whole point of a number: it has to be legible from
 * wherever the camera happens to be.
 */
import { memo } from "react";

import type { Box } from "../../lib/canvas";

interface Props {
  spots: readonly Box[];
  /** Which spot the card currently occupies (drawn solid, not dashed). */
  hereIndex: number;
  onPick: (index: number) => void;
}

function PlacementHintsImpl({ spots, hereIndex, onPick }: Props) {
  return (
    <>
      {spots.map((s, i) => (
        <div
          key={i}
          className={`cv-ghost ${i === hereIndex ? "is-here" : ""}`}
          style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
          role="button"
          aria-label={`${i + 1}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            onPick(i);
          }}
        >
          <span className="cv-ghost-num" aria-hidden="true">
            {i + 1}
          </span>
        </div>
      ))}
    </>
  );
}

export const PlacementHints = memo(PlacementHintsImpl);
