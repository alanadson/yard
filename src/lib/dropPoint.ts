/**
 * Where a new thing lands on the canvas.
 *
 * The drawing tools always knew: the note is born under the click, because
 * the click *is* the gesture. Everything else was born somewhere else — a
 * terminal at the next free slot of a 3-column grid, a portal at (80, 80) —
 * and the user was left dragging each new card from wherever the code put it
 * to wherever they had just pointed.
 *
 * The point of this module is that "here" is one idea with one answer, and
 * that the answer is reachable from outside the canvas: the "+ Terminal"
 * button lives in the title bar and the palette runs over everything, so
 * neither has a click on the board to hand to the creator. The canvas
 * registers a reader for its camera and the creators ask for a spot.
 *
 * Nothing here touches React or a store — it is arithmetic plus a registry,
 * which is what makes `dropAt` testable on its own.
 */

/** Size of the thing about to be placed; only used to keep it on screen. */
export interface DropSize {
  w: number;
  h: number;
}

/** Top-left corner, in world units, of the thing about to be placed. */
export interface DropPoint {
  x: number;
  y: number;
}

/** What the canvas has to expose for a spot to be computable. */
export interface DropCamera {
  /** The visible rectangle, in world units. */
  view: { x: number; y: number; w: number; h: number };
  /**
   * Last pointer position over the canvas, in world units — `null` until the
   * mouse has been over the board at least once (a fresh window, a keyboard
   * shortcut fired before any movement).
   */
  cursor: DropPoint | null;
}

/**
 * The spot, from a camera.
 *
 * With a cursor the point *is* the top-left corner: what you pointed at is
 * where the thing starts, the same contract the note and the text tools have
 * always had. Without one, the middle of the screen is the honest reading of
 * "here" — and there the box is centered instead, since a 640px card whose
 * corner sits at the center reads as off to one side rather than middle.
 *
 * Both are then pulled back inside the visible rectangle. A right-click 20px
 * from the right edge means "over there", not "mostly off screen", and a card
 * the user cannot see is a card they will not find. Boxes bigger than the
 * viewport (zoomed right in) just start at the top-left corner of the view.
 */
export function dropAt(cam: DropCamera, size?: DropSize): DropPoint {
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const raw = cam.cursor ?? {
    x: cam.view.x + (cam.view.w - w) / 2,
    y: cam.view.y + (cam.view.h - h) / 2,
  };
  return {
    x: clampSpan(raw.x, cam.view.x, cam.view.w, w),
    y: clampSpan(raw.y, cam.view.y, cam.view.h, h),
  };
}

/** One axis of the "keep it on screen" clamp. */
function clampSpan(v: number, min: number, span: number, size: number): number {
  return Math.max(min, Math.min(v, min + span - size));
}

/** Two corners this close count as the same spot. */
const SAME = 2;

/**
 * Steps the spot down-right while something already sits exactly on it.
 *
 * Placing at the cursor is right until the cursor does not move: three
 * Ctrl+T in a row used to fan out across the automatic grid, and would now
 * bury three cards in the same pile with only the top one visible. The offset
 * is the cascade every window manager has used for this, and it gives up
 * after a few tries — at that point the pile is the user's doing.
 */
export function unstack(
  spot: DropPoint,
  taken: readonly DropPoint[],
  step = 28,
): DropPoint {
  let { x, y } = spot;
  for (let i = 0; i < 12; i += 1) {
    const clash = taken.some(
      (t) => Math.abs(t.x - x) < SAME && Math.abs(t.y - y) < SAME, // i18n-ok
    );
    if (!clash) break;
    x += step;
    y += step;
  }
  return { x, y };
}

type Reader = () => DropCamera | null;

/**
 * One canvas is mounted at a time in practice, but the key is the group: a
 * modal opened over group A must not place its card using group B's camera,
 * and a stale reader left behind by an unmounted view would do exactly that.
 */
const readers = new Map<string, Reader>();

/** Called by the canvas view; the returned function unregisters it. */
export function registerDropCamera(groupId: string, read: Reader): () => void {
  readers.set(groupId, read);
  return () => {
    if (readers.get(groupId) === read) readers.delete(groupId);
  };
}

/**
 * Where to put a new thing in this group, or `null` when nobody can say —
 * the group is showing panes instead of a canvas, or it is not on screen at
 * all. Callers keep their old placement for that case: a spot invented here
 * without a camera would be worse than the grid it replaced.
 */
export function dropPointFor(
  groupId: string | null | undefined,
  size?: DropSize,
): DropPoint | null {
  const cam = cameraFor(groupId);
  return cam ? dropAt(cam, size) : null;
}

/**
 * The camera itself, for a caller that needs more than a point: the guided
 * placement ranks its offers from the cursor and keeps them inside the view.
 */
export function cameraFor(groupId: string | null | undefined): DropCamera | null {
  if (!groupId) return null;
  return readers.get(groupId)?.() ?? null;
}
