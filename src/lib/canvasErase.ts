/**
 * The eraser's arithmetic, away from React and the DOM.
 *
 * Every other gesture on the canvas drains into one update per frame; the
 * eraser used to hit-test the whole board on every pointer event, reading
 * the container's rectangle each time and setting state each time. Now the
 * events only queue their samples (all of them: the browser coalesces a fast
 * sweep into one event per frame, and the samples in between are exactly
 * where a thin stroke gets crossed), and the frame tests the queue in one
 * pass. The pass must erase what testing each sample on its own would have:
 * `canvasErase.test.ts` holds it to that.
 */
import { hitItem, type CanvasItem, type CanvasNode, type CanvasViewport } from "./canvas";

/** How close the eraser reaches, in screen px: divided by the zoom per point. */
export const ERASER_TOL_PX = 6;

/** One point the eraser passed over, in world px, with its reach at the zoom of the moment. */
export interface ErasePoint {
  x: number;
  y: number;
  tol: number;
}

/**
 * A sample waiting for its frame: client px plus the camera it was taken
 * under. The camera travels with the point because the frame that tests it
 * can come after a wheel pan or a zoom; converting then with the camera of
 * then would erase somewhere the pointer never was.
 */
export interface QueuedErase {
  clientX: number;
  clientY: number;
  camera: CanvasViewport;
}

/**
 * The queued samples in world px. Same arithmetic as the canvas' own
 * `toWorld`, with the container's rectangle read once for the whole frame
 * instead of once per event.
 */
export function erasePoints(
  queue: readonly QueuedErase[],
  rect: { left: number; top: number },
): ErasePoint[] {
  return queue.map((q) => ({
    x: (q.clientX - rect.left) / q.camera.zoom + q.camera.x,
    y: (q.clientY - rect.top) / q.camera.zoom + q.camera.y,
    tol: ERASER_TOL_PX / q.camera.zoom,
  }));
}

/** Anything with a pointer position: a `PointerEvent`, or a sample of one. */
export interface PointerSample {
  clientX: number;
  clientY: number;
}

/**
 * Every position a pointer event stands for. Pointermove arrives coalesced:
 * the browser delivers the last event of the frame and keeps the ones in
 * between, and for the pen and the eraser those in-between samples are the
 * gesture itself. An event with none (or a browser without the API) stands
 * for itself.
 */
export function pointerSamples<E extends PointerSample>(
  ev: E & { getCoalescedEvents?: () => E[] },
): E[] {
  const coalesced =
    typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : null;
  return coalesced && coalesced.length ? coalesced : [ev];
}

/**
 * Ids of the items the points touch, in board order, leaving out what is
 * already erased. Equal, as a set, to testing the points one by one and
 * skipping what each one took: an item is in either answer exactly when some
 * point hits it. Two items sharing an id are one id erased.
 */
export function erasedBy(
  items: readonly CanvasItem[],
  points: readonly ErasePoint[],
  nodeOf: (id: string) => CanvasNode | undefined,
  already: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  if (points.length === 0) return out;
  const taken = new Set<string>();
  for (const it of items) {
    if (already.has(it.id) || taken.has(it.id)) continue;
    for (const p of points) {
      if (hitItem(it, p.x, p.y, p.tol, nodeOf)) {
        taken.add(it.id);
        out.push(it.id);
        break;
      }
    }
  }
  return out;
}
