/**
 * The vector layer: pen strokes, rough shapes and free arrows. Sits
 * **above** the cards (drawing over a terminal works, like on
 * glass), but only the hit-paths receive pointer events — and only with the
 * selection tool active. Connections between cards moved to `ConnectionsLayer`,
 * which sits on the other side of the stack (below the cards).
 *
 * Fluency, in three layers of defense:
 * - each item is its own memoized component: a keystroke in a note or a
 *   new stroke re-renders one item, not the list;
 * - dragging an item regenerates no paths — the offset becomes a
 *   `translate` on the item's `<g>`, and the cached path stays quiet;
 * - pan/zoom don't touch the children: the `kids` array is memoized without
 *   `vp`, and the frame only swaps the root `<g>` transform. Hit-paths use
 *   `vector-effect: non-scaling-stroke` so the click area stays constant
 *   in screen px without depending on zoom in the render.
 */
import { memo, useMemo } from "react";

import {
  itemBounds,
  STROKE_PX,
  type CanvasItem,
  type CanvasViewport,
} from "../../lib/canvas";
import { freehandPathCached, freehandPath, roughShapePaths } from "./render";

interface Props {
  items: CanvasItem[];
  vp: CanvasViewport;
  selection: string | null;
  /** Ids marked by the eraser in this drag (painted faded). */
  fading: Set<string>;
  dragDelta: { id: string; dx: number; dy: number } | null;
  draft: CanvasItem | null;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
}

interface VectorItemProps {
  it: CanvasItem;
  dx: number;
  dy: number;
  faded: boolean;
  /** The in-progress draft doesn't need (nor should it) receive pointer events. */
  hit: boolean;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
}

function VectorItemImpl({
  it,
  dx,
  dy,
  faded,
  hit,
  onItemDown,
  onItemMove,
  onItemUp,
}: VectorItemProps) {
  const g: React.ReactNode[] = [];

  switch (it.type) {
    case "stroke": {
      const d =
        it.id === "__draft" ? freehandPath(it.points, it.size) : freehandPathCached(it);
      g.push(<path key="p" d={d} fill={it.color} stroke="none" />);
      if (hit)
        g.push(
          <path
            key="h"
            className="cv-hit"
            d={polylineD(it.points)}
            fill="none"
            stroke="transparent"
            strokeWidth={STROKE_PX[it.size] * 2 + 12}
            vectorEffect="non-scaling-stroke"
            onPointerDown={(e) => onItemDown(e, it.id)}
            onPointerMove={onItemMove}
            onPointerUp={onItemUp}
          />,
        );
      break;
    }
    case "rect":
    case "ellipse":
    case "line":
    case "arrow": {
      const ds = roughShapePaths(it);
      ds.forEach((d, i) =>
        g.push(
          <path
            key={`p${i}`}
            d={d}
            fill="none"
            stroke={it.color}
            strokeWidth={STROKE_PX[it.size]}
            strokeLinecap="round"
          />,
        ),
      );
      if (hit)
        g.push(
          <path
            key="h"
            className="cv-hit"
            d={ds[0]}
            fill="none"
            stroke="transparent"
            strokeWidth={STROKE_PX[it.size] + 12}
            vectorEffect="non-scaling-stroke"
            onPointerDown={(e) => onItemDown(e, it.id)}
            onPointerMove={onItemMove}
            onPointerUp={onItemUp}
          />,
        );
      break;
    }
    default:
      // text, note and connection live in other layers
      return null;
  }

  return (
    <g
      opacity={faded ? 0.22 : 1}
      transform={dx || dy ? `translate(${dx} ${dy})` : undefined}
    >
      {g}
    </g>
  );
}

const VectorItem = memo(VectorItemImpl);

function ItemsLayerImpl({
  items,
  vp,
  selection,
  fading,
  dragDelta,
  draft,
  onItemDown,
  onItemMove,
  onItemUp,
}: Props) {
  const z = vp.zoom;

  // No `vp` in the dependencies: pan and zoom don't rebuild the list.
  const kids = useMemo(
    () =>
      items.map((it) => {
        if (it.type === "text" || it.type === "note" || it.type === "portal" || it.type === "connection")
          return null;
        const dragged = dragDelta && dragDelta.id === it.id;
        return (
          <VectorItem
            key={it.id}
            it={it}
            dx={dragged ? dragDelta.dx : 0}
            dy={dragged ? dragDelta.dy : 0}
            faded={fading.has(it.id)}
            hit
            onItemDown={onItemDown}
            onItemMove={onItemMove}
            onItemUp={onItemUp}
          />
        );
      }),
    [items, fading, dragDelta, onItemDown, onItemMove, onItemUp],
  );

  // No "connection" is possible here (the layer ignores them), and it's the
  // only case where itemBounds needs nodeOf.
  const selected = selection ? items.find((i) => i.id === selection) : null;
  let bounds =
    selected && selected.type !== "connection"
      ? itemBounds(selected, () => undefined)
      : null;
  if (bounds && dragDelta && selected && selected.id === dragDelta.id) {
    bounds = { ...bounds, x: bounds.x + dragDelta.dx, y: bounds.y + dragDelta.dy };
  }

  return (
    <svg className="cv-svg">
      <g transform={`translate(${-vp.x * z} ${-vp.y * z}) scale(${z})`}>
        {kids}
        {draft && (
          <VectorItem
            it={draft}
            dx={0}
            dy={0}
            faded={false}
            hit={false}
            onItemDown={onItemDown}
            onItemMove={onItemMove}
            onItemUp={onItemUp}
          />
        )}
        {bounds && (
          <rect
            className="cv-selection"
            x={bounds.x - 6}
            y={bounds.y - 6}
            width={bounds.w + 12}
            height={bounds.h + 12}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </g>
    </svg>
  );
}

function polylineD(points: number[]): string {
  let d = `M ${points[0]} ${points[1]}`;
  for (let i = 2; i + 1 < points.length; i += 2) d += ` L ${points[i]} ${points[i + 1]}`;
  return d;
}

export const ItemsLayer = memo(ItemsLayerImpl);
