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
 *   `translate` on the item's `<g>`, and the cached path stays quiet; only
 *   the dragged items get a new element on each frame (`vectorDrag.ts`);
 * - pan/zoom don't touch the children: the `kids` array is memoized without
 *   `vp`, and the frame only swaps the root `<g>` transform. Hit-paths use
 *   `vector-effect: non-scaling-stroke` so the click area stays constant
 *   in screen px without depending on zoom in the render.
 */
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ResizeHandles } from "./ResizeHandles";
import { dragShift, withDragged, type VectorDrag } from "./vectorDrag";
import { resizeVectorItem } from "../../lib/itemSizing";

import {
  STROKE_PX,
  itemBounds,
  type ResizeDir,
  type CanvasItem,
  type CanvasViewport,
} from "../../lib/canvas";
import { freehandPathCached, freehandPath, roughShapePaths } from "./render";

interface Props {
  getZoom: () => number;
  onResize: (id: string, dir: ResizeDir, dx: number, dy: number) => void;
  items: CanvasItem[];
  vp: CanvasViewport;
  selection: ReadonlySet<string>;
  /** Ids marked by the eraser in this drag (painted faded). */
  fading: Set<string>;
  dragDelta: VectorDrag | null;
  draft: CanvasItem | null;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
}

interface VectorItemProps {
  selected?: boolean;
  getZoom: () => number;
  onResize: Props["onResize"];
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
  it: original,
  selected,
  getZoom,
  onResize,
  dx,
  dy,
  faded,
  hit,
  onItemDown,
  onItemMove,
  onItemUp,
}: VectorItemProps) {
  const [preview, setPreview] = useState<CanvasItem | null>(null);
  const session = useRef<{
    pointerId: number;
    x: number;
    y: number;
    dir: ResizeDir;
    item: CanvasItem;
  } | null>(null);
  const it = preview ?? original;
  const bounds = selected ? itemBounds(it, () => undefined) : null;
  const resize = (e: React.PointerEvent, commit: boolean) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    e.stopPropagation();
    const dx = (e.clientX - s.x) / getZoom();
    const dy = (e.clientY - s.y) / getZoom();
    if (commit || e.type === "pointercancel") {
      session.current = null;
      setPreview(null);
      if (e.type !== "pointercancel" && (dx || dy))
        onResize(original.id, s.dir, dx, dy);
    } else {
      setPreview(resizeVectorItem(s.item, s.dir, dx, dy));
    }
  };
  const g: React.ReactNode[] = [];

  switch (it.type) {
    case "stroke": {
      const d =
        it.id === "__draft"
          ? freehandPath(it.points, it.size)
          : freehandPathCached(it);
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
      {bounds && (
        <>
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
          {!it.pinned && (
            <foreignObject
              x={bounds.x}
              y={bounds.y}
              width={Math.max(1, bounds.w)}
              height={Math.max(1, bounds.h)}
              className="cv-vector-grips"
            >
              <div className="cv-vector-box is-selected">
                <ResizeHandles
                  onDown={(e, dir) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    session.current = {
                      pointerId: e.pointerId,
                      x: e.clientX,
                      y: e.clientY,
                      dir,
                      item: original,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onMove={(e) => resize(e, false)}
                  onUp={(e) => resize(e, true)}
                />
              </div>
            </foreignObject>
          )}
        </>
      )}
    </g>
  );
}

const VectorItem = memo(VectorItemImpl);

function ItemsLayerImpl({
  getZoom,
  onResize,
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

  // No `vp` in any of the dependencies below: pan and zoom don't rebuild the list.
  const vectorItem = useCallback(
    (it: CanvasItem, dx: number, dy: number) => (
      <VectorItem
        key={it.id}
        it={it}
        selected={selection.has(it.id)}
        getZoom={getZoom}
        onResize={onResize}
        dx={dx}
        dy={dy}
        faded={fading.has(it.id)}
        hit
        onItemDown={onItemDown}
        onItemMove={onItemMove}
        onItemUp={onItemUp}
      />
    ),
    [selection, fading, onItemDown, onItemMove, onItemUp, getZoom, onResize],
  );

  // The list at rest, with no drag in its dependencies: a drag frame swaps in
  // new elements only for the items being dragged (`vectorDrag.ts`), and every
  // other one stays the very element it was.
  const atRest = useMemo(
    () =>
      items.map((it) =>
        it.type === "text" ||
        it.type === "note" ||
        it.type === "portal" ||
        it.type === "connection"
          ? null
          : vectorItem(it, 0, 0),
      ),
    [items, vectorItem],
  );
  const kids = useMemo(
    () =>
      withDragged(atRest, items, dragDelta, (i) => {
        const { dx, dy } = dragShift(dragDelta, items[i].id);
        return vectorItem(items[i], dx, dy);
      }),
    [atRest, items, dragDelta, vectorItem],
  );

  return (
    <svg className="cv-svg" style={{ "--cv-z": z } as React.CSSProperties}>
      <g transform={`translate(${-vp.x * z} ${-vp.y * z}) scale(${z})`}>
        {kids}
        {draft && (
          <VectorItem
            it={draft}
            getZoom={getZoom}
            onResize={onResize}
            dx={0}
            dy={0}
            faded={false}
            hit={false}
            onItemDown={onItemDown}
            onItemMove={onItemMove}
            onItemUp={onItemUp}
          />
        )}
      </g>
    </svg>
  );
}

function polylineD(points: number[]): string {
  let d = `M ${points[0]} ${points[1]}`;
  for (let i = 2; i + 1 < points.length; i += 2)
    d += ` L ${points[i]} ${points[i + 1]}`;
  return d;
}

export const ItemsLayer = memo(ItemsLayerImpl);
