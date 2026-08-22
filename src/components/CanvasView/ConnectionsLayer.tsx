/**
 * Canvas wiring: connections between cards/notes. Sits **below** the
 * cards and notes (like a cable under the table) — unlike the drawings
 * in `ItemsLayer`, which sit on top on purpose (drawing over a
 * terminal works like drawing on glass). Separate SVG because the two layers
 * live at different points in the stacking order (see `.cv-svg--under`
 * in styles.css).
 *
 * The wires themselves are memoized without `vp`: pan and zoom only swap the
 * transform of the root `<g>`. Dragging a card changes `rects` and recalculates
 * the curves (they need to follow the card) — but nothing else. The hit-path
 * uses `vector-effect: non-scaling-stroke` so the click area stays fixed in
 * screen px without involving zoom in the render.
 *
 * Stroke width, opacity and hover live in CSS (`.cv-conn*` in styles.css): the
 * hover highlight must not cost a re-render of this list, which is a
 * hot path during drag.
 *
 * The slack (`lib/wobble.ts`) is written straight into the `d` attribute,
 * outside React. A swing is some forty frames, and one `setState` per frame
 * per wire would re-render this list while the user is still dragging — the
 * exact cost the rest of the file is built to avoid.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";

import {
  connectionGeometry,
  type CanvasItem,
  type CanvasNode,
  type CanvasViewport,
  type ConnectionGeom,
} from "../../lib/canvas";
import {
  belly,
  cablePath,
  motionAllowed,
  restingSpring,
  sleep,
  stepSpring,
  wake,
  type Spring,
} from "../../lib/wobble";

/**
 * Hangs the wire's belly on a spring and paints the frames itself.
 *
 * Returns the `ref` the three paths share: they are the same curve (halo,
 * cable, hit area) and must bend together. React keeps rendering the wire at
 * rest — that is what the DOM shows if the spring never wakes, and it is
 * what a browser without animation frames shows too.
 */
function useCable(geom: ConnectionGeom) {
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const cubic = useRef(geom.cubic);
  cubic.current = geom.cubic;
  const spring = useRef<Spring | null>(null);

  const paint = useCallback((ox: number, oy: number) => {
    const d = cablePath(cubic.current, ox, oy);
    for (const p of paths.current) p?.setAttribute("d", d);
  }, []);

  // One stable tick per wire: it reads refs, so it never goes stale and the
  // driver can keep the same identity in its set across renders.
  const tick = useRef<((dt: number) => boolean) | null>(null);
  if (!tick.current) {
    tick.current = (dt) => {
      const s = spring.current;
      if (!s) return false;
      const [bx, by] = belly(cubic.current);
      const alive = stepSpring(s, bx, by, dt);
      paint(s.x - bx, s.y - by);
      return alive;
    };
  }

  useLayoutEffect(() => {
    const [bx, by] = belly(cubic.current);
    const s = spring.current;
    // First layout: the wire is born already at rest, no swing on load.
    if (!s) {
      spring.current = restingSpring(bx, by);
      return;
    }
    if (!motionAllowed()) {
      s.x = bx;
      s.y = by;
      s.vx = 0;
      s.vy = 0;
      return;
    }
    // React has just written the curve at rest. Repaint with the slack the
    // spring is currently carrying, before the frame is shown, or a drag
    // flickers between the rigid wire and the loose one.
    paint(s.x - bx, s.y - by);
    if (Math.abs(s.x - bx) > 0.01 || Math.abs(s.y - by) > 0.01) wake(tick.current!);
  });

  useLayoutEffect(() => {
    const t = tick.current!;
    return () => sleep(t);
  }, []);

  return paths;
}

interface Props {
  items: CanvasItem[];
  rects: Record<string, CanvasNode>;
  vp: CanvasViewport;
  selection: ReadonlySet<string>;
  /** Connection being created: from the source card's center to the cursor. */
  pendingConnect: { from: CanvasNode; to: { x: number; y: number } } | null;
  /**
   * Extra class per connection id while a flow runs over it
   * (`is-flow-active|done|error`, plus `is-flow-rev` when the cable was
   * drawn from the CLI toward the flow card). Kept as strings so the
   * memoized `Connection` bails out for every wire whose class is unchanged.
   */
  flowClasses: Record<string, string>;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
}

/**
 * One wire. Memoized per connection so that dragging a card only recomputes
 * the beziers of the wires attached to it: `rects` changes identity every
 * frame of the gesture, but the two rectangles an untouched wire depends on
 * do not, and reconciliation keeps their references stable.
 *
 * No color prop: every wire is the same white cable (the stroke lives in
 * CSS). The wiring is plumbing between cards, not drawing — a palette here
 * would compete with the cards for attention and with the pen for meaning.
 */
const Connection = memo(function Connection({
  id,
  a,
  b,
  selected,
  flowClass,
  onItemDown,
  onItemMove,
  onItemUp,
}: {
  id: string;
  a: CanvasNode;
  b: CanvasNode;
  selected: boolean;
  /** State of the flow currently running over this wire ("" when none). */
  flowClass: string;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
}) {
  const geom = connectionGeometry(a, b);
  const paths = useCable(geom);
  return (
    <g className={`cv-conn ${selected ? "is-selected" : ""} ${flowClass}`}>
      {selected && (
        // Halo: wide outline under the line itself, the flow-editor
        // selection highlight.
        <path
          className="cv-conn-halo"
          ref={(el) => void (paths.current[0] = el)}
          d={geom.d}
          fill="none"
        />
      )}
      <path
        className="cv-conn-line"
        ref={(el) => void (paths.current[1] = el)}
        d={geom.d}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="cv-hit"
        ref={(el) => void (paths.current[2] = el)}
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
  flowClasses,
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
            a={a}
            b={b}
            selected={selection.has(it.id)}
            flowClass={flowClasses[it.id] ?? ""}
            onItemDown={onItemDown}
            onItemMove={onItemMove}
            onItemUp={onItemUp}
          />
        );
      }),
    [items, rects, selection, flowClasses, onItemDown, onItemMove, onItemUp],
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
