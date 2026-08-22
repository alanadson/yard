/**
 * The transient marks of a gesture: the marquee being dragged, the magnetic
 * guides while something is being moved, and the outline around a
 * multi-selection.
 *
 * They live in their own `<svg>` above the vector layer because none of them
 * belong to the document: they exist for the duration of a drag, they are
 * never persisted, they are never hit-tested. Keeping them out of
 * `ItemsLayer` also keeps that layer's `kids` memo from being invalidated
 * sixty times a second by a rectangle that has nothing to do with it.
 */
import { memo } from "react";

import type { SnapGuide } from "../../lib/arrange";
import type { Box, CanvasViewport } from "../../lib/canvas";

interface Props {
  vp: CanvasViewport;
  /** Rubber band being dragged, in world coordinates. */
  marquee: Box | null;
  guides: readonly SnapGuide[];
  /** Outline around everything selected — only worth drawing past one item. */
  bbox: Box | null;
}

function SelectionLayerImpl({ vp, marquee, guides, bbox }: Props) {
  if (!marquee && !bbox && guides.length === 0) return null;
  const z = vp.zoom;

  return (
    <svg className="cv-svg cv-svg--over">
      <g transform={`translate(${-vp.x * z} ${-vp.y * z}) scale(${z})`}>
        {bbox && (
          // Sixteen px out, not eight: every selected element already carries
          // its own ring 6px outside itself, and a group frame two px past
          // those reads as a rendering glitch instead of as an enclosure.
          <rect
            className="cv-multi-box"
            x={bbox.x - 16}
            y={bbox.y - 16}
            width={bbox.w + 32}
            height={bbox.h + 32}
            rx={6}
            fill="none"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {guides.map((g, i) => (
          <line
            key={`${g.axis}${g.at}${i}`}
            className="cv-guide"
            x1={g.axis === "x" ? g.at : g.from}
            y1={g.axis === "x" ? g.from : g.at}
            x2={g.axis === "x" ? g.at : g.to}
            y2={g.axis === "x" ? g.to : g.at}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {marquee && (
          <rect
            className="cv-marquee"
            x={marquee.x}
            y={marquee.y}
            width={marquee.w}
            height={marquee.h}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </g>
    </svg>
  );
}

export const SelectionLayer = memo(SelectionLayerImpl);
