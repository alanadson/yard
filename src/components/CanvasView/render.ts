/**
 * Conversion of canvas items into SVG paths that look hand-drawn.
 *
 * roughjs generates the shapes (with a fixed `seed` per item — without it each
 * render would roll a new scribble and the screen would "boil") and
 * perfect-freehand turns the pen's point sequence into an outline with
 * variable thickness.
 *
 * Generating a rough path is expensive enough not to run on every zoom frame;
 * the per-geometry cache solves it, since items are immutable outside of edit.
 */
import rough from "roughjs";
import { getStroke } from "perfect-freehand";

import { STROKE_PX, type CanvasItem } from "../../lib/canvas";
import { Lru } from "../../lib/lru";

const gen = rough.generator();

const cache = new Lru<string, string[]>(800);

function cached(key: string, make: () => string[]): string[] {
  const hit = cache.get(key);
  if (hit) return hit;
  const made = make();
  cache.set(key, made);
  return made;
}

/**
 * The in-progress draft changes geometry every frame; caching it would flush
 * the already-committed items' cache mid-gesture. It draws without cache.
 */
const DRAFT_ID = "__draft";

type ShapeItem = Extract<CanvasItem, { type: "rect" | "ellipse" | "line" | "arrow" }>;

const ROUGH_OPTS = { roughness: 1.3, bowing: 1.1 };

/** Paths (`d` attribute) of the shape; color is applied at paint time. */
export function roughShapePaths(it: ShapeItem): string[] {
  const sw = STROKE_PX[it.size];
  const make = (): string[] => {
    switch (it.type) {
      case "rect":
        return drawableToDs(
          gen.rectangle(it.x, it.y, it.w, it.h, {
            ...ROUGH_OPTS,
            seed: it.seed,
            strokeWidth: sw,
          }),
        );
      case "ellipse":
        return drawableToDs(
          gen.ellipse(it.x + it.w / 2, it.y + it.h / 2, Math.abs(it.w), Math.abs(it.h), {
            ...ROUGH_OPTS,
            seed: it.seed,
            strokeWidth: sw,
          }),
        );
      case "line":
        return drawableToDs(
          gen.line(it.x1, it.y1, it.x2, it.y2, {
            ...ROUGH_OPTS,
            seed: it.seed,
            strokeWidth: sw,
          }),
        );
      case "arrow": {
        const angle = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
        const len = Math.min(26, 13 + sw * 2.2);
        const spread = 0.5;
        const mk = (a: number, seedShift: number) =>
          gen.line(
            it.x2,
            it.y2,
            it.x2 - len * Math.cos(a),
            it.y2 - len * Math.sin(a),
            { ...ROUGH_OPTS, seed: it.seed + seedShift, strokeWidth: sw },
          );
        return [
          ...drawableToDs(
            gen.line(it.x1, it.y1, it.x2, it.y2, {
              ...ROUGH_OPTS,
              seed: it.seed,
              strokeWidth: sw,
            }),
          ),
          ...drawableToDs(mk(angle - spread, 1)),
          ...drawableToDs(mk(angle + spread, 2)),
        ];
      }
    }
  };
  if (it.id === DRAFT_ID) return make();
  return cached(`${shapeKey(it)},${sw}`, make);
}

function shapeKey(it: ShapeItem): string {
  switch (it.type) {
    case "rect":
    case "ellipse":
      return `${it.type[0]}:${it.x},${it.y},${it.w},${it.h},${it.seed}`;
    case "line":
    case "arrow":
      return `${it.type[0]}:${it.x1},${it.y1},${it.x2},${it.y2},${it.seed}`;
  }
}

function drawableToDs(drawable: ReturnType<typeof gen.rectangle>): string[] {
  return gen.toPaths(drawable).map((p) => p.d);
}

/**
 * Filled outline of the pen stroke. `points` is the flattened list
 * [x0, y0, x1, y1, ...] in world coordinates.
 */
export function freehandPath(points: number[], size: keyof typeof STROKE_PX): string {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  return outlineToPath(
    getStroke(pts, {
      size: STROKE_PX[size] * 2.4,
      thinning: 0.55,
      smoothing: 0.62,
      streamline: 0.45,
      last: true,
    }),
  );
}

export function freehandPathCached(
  it: Extract<CanvasItem, { type: "stroke" }>,
): string {
  // The first point goes into the key: moving the stroke translates every
  // point, and without this the cache would return the drawing stuck in the old place.
  const key = `f:${it.id}:${it.points.length}:${it.size}:${it.points[0]},${it.points[1]}`;
  return cached(key, () => [freehandPath(it.points, it.size)])[0];
}

/** perfect-freehand polygon -> path with quadratics (smooth curve). */
function outlineToPath(outline: number[][]): string {
  if (outline.length < 2) return "";
  let d = `M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)} Q`;
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    d += ` ${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`;
  }
  return d + " Z";
}
