/**
 * Canvas wiring: connections between cards/notes. Sits **below** the
 * cards and notes (like a cable under the table) — unlike the drawings
 * in `ItemsLayer`, which sit on top on purpose (drawing over a
 * terminal works like drawing on glass). Separate SVG because the two layers
 * live at different points in the stacking order (see `.cv-svg--under`
 * in styles.css).
 *
 * The arrows themselves are memoized without `vp`: pan and zoom only swap the
 * transform of the root `<g>`. Dragging a card changes `rects` and recalculates
 * the curves (they need to follow the card) — but nothing else. The hit-path
 * uses `vector-effect: non-scaling-stroke` so the click area stays fixed in
 * screen px without involving zoom in the render.
 *
 * Stroke width, opacity and hover live in CSS (`.cv-conn*` in styles.css): the
 * hover highlight must not cost a re-render of this list, which is a
 * hot path during drag.
 */
import { memo, useMemo } from "react";

import {
  connectionGeometry,
  type CanvasItem,
  type CanvasNode,
  type CanvasViewport,
} from "../../lib/canvas";

interface Props {
  items: CanvasItem[];
  rects: Record<string, CanvasNode>;
  vp: CanvasViewport;
  selection: string | null;
  /** Connection being created: from the source card's center to the cursor. */
  pendingConnect: { from: CanvasNode; to: { x: number; y: number } } | null;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
}

/**
 * One wire. Memoized per connection so that dragging a card only recomputes
 * the beziers of the wires attached to it: `rects` changes identity every
 * frame of the gesture, but the two rectangles an untouched wire depends on
 * do not, and reconciliation keeps their references stable.
 */
const Connection = memo(function Connection({
  id,
  color,
  a,
  b,
  selected,
  onItemDown,
  onItemMove,
  onItemUp,
}: {
  id: string;
  color: string;
  a: CanvasNode;
  b: CanvasNode;
  selected: boolean;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
}) {
  const geom = connectionGeometry(a, b);
  return (
    <g className={`cv-conn ${selected ? "is-selected" : ""}`}>
      {selected && (
        // Halo: wide outline under the line itself, the flow-editor
        // selection highlight (does not change the wire's color).
        <path className="cv-conn-halo" d={geom.d} fill="none" stroke={color} />
      )}
      <path
        className="cv-conn-line"
        d={geom.d}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon className="cv-conn-head" points={geom.head} fill={color} />
      <path
        className="cv-hit"
        d={geom.d}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        vectorEffect="non-scaling-stroke"
        onPointerDown={(e) => onItemDown(e, id)}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      />
    </g>
  );
});

function ConnectionsLayerImpl({
  items,
  rects,
  vp,
  selection,
  pendingConnect,
  onItemDown,
  onItemMove,
  onItemUp,
}: Props) {
  const z = vp.zoom;

  const kids = useMemo(
    () =>
      items.map((it) => {
        if (it.type !== "connection") return null;
        const a = rects[it.from];
        const b = rects[it.to];
        if (!a || !b) return null;
        return (
          <Connection
            key={it.id}
            id={it.id}
            color={it.color}
            a={a}
            b={b}
            selected={selection === it.id}
            onItemDown={onItemDown}
            onItemMove={onItemMove}
            onItemUp={onItemUp}
          />
        );
      }),
    [items, rects, selection, onItemDown, onItemMove, onItemUp],
  );

  return (
    <svg className="cv-svg cv-svg--under">
      <g transform={`translate(${-vp.x * z} ${-vp.y * z}) scale(${z})`}>
        {kids}
        {pendingConnect && (
          // Everything here is divided by zoom: the provisional wire is cursor
          // feedback, so it has constant thickness in screen px. The dash
          // runs toward the target (`--cv-dash` feeds the keyframe).
          <g style={{ "--cv-dash": `${11 / z}` } as React.CSSProperties}>
            <path
              className="cv-conn-pending"
              d={`M ${pendingConnect.from.x + pendingConnect.from.w / 2} ${
                pendingConnect.from.y + pendingConnect.from.h / 2
              } L ${pendingConnect.to.x} ${pendingConnect.to.y}`}
              fill="none"
              stroke="var(--accent-border)"
              strokeWidth={2 / z}
              strokeLinecap="round"
              strokeDasharray={`${6 / z} ${5 / z}`}
            />
            <circle
              cx={pendingConnect.to.x}
              cy={pendingConnect.to.y}
              r={4 / z}
              fill="var(--accent)"
            />
          </g>
        )}
      </g>
    </svg>
  );
}

export const ConnectionsLayer = memo(ConnectionsLayerImpl);
