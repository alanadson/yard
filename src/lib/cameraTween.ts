/**
 * The camera's motion, as arithmetic.
 *
 * Every jump the board makes (frame all, centre on a card, zoom to a level)
 * used to be a `setVp` with the final numbers: the screen cut from one place
 * to another, and after two cuts nobody knows where they are any more. A
 * glide keeps the eye on the path. The maths lives here, away from React and
 * from `requestAnimationFrame`, so the one property that matters can be
 * locked by a test: the same elapsed time gives the same position, whether it
 * arrived as one long frame or several short ones.
 *
 * The second half is inertia for a thrown pan: the velocity of the last few
 * pointer samples, decayed per frame until it is not worth a repaint.
 */

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** One frame at 60 Hz, the unit every per-frame constant is written in. */
export const FRAME_MS = 1000 / 60;

/** Fraction of the remaining distance a glide covers on one 60 Hz frame. */
export const TWEEN_EASE = 0.18;

/** Under this, in world px, the glide snaps onto its target. */
const SNAP_PX = 0.5;
/** Same, for the zoom factor. */
const SNAP_ZOOM = 0.001;

/**
 * The fraction of the remaining distance to cover after `elapsedMs`.
 *
 * `1 - (1 - ease)^(frames)`: applying it on two half frames composes into
 * exactly one whole frame, which is what makes the glide the same speed on
 * every monitor.
 */
export function easeForElapsed(elapsedMs: number, easePerFrame = TWEEN_EASE): number {
  if (!(elapsedMs > 0)) return 0;
  return Math.min(1, 1 - (1 - easePerFrame) ** (elapsedMs / FRAME_MS));
}

/**
 * One step of the glide from `current` toward `target`.
 *
 * Zoom is eased in log space: from 1x to 2x and from 2x to 4x are the same
 * visual distance, and a linear ease would rush the first and crawl the last.
 * `done` comes with the target itself, so the caller can write the exact
 * numbers it asked for and the terminal underneath lands on whole pixels.
 */
export function stepCamera(
  current: Camera,
  target: Camera,
  elapsedMs: number,
  easePerFrame = TWEEN_EASE,
): { camera: Camera; done: boolean } {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const dz = target.zoom - current.zoom;
  if (Math.abs(dx) < SNAP_PX && Math.abs(dy) < SNAP_PX && Math.abs(dz) < SNAP_ZOOM) {
    return { camera: { ...target }, done: true };
  }
  const k = easeForElapsed(elapsedMs, easePerFrame);
  const lz = Math.log(current.zoom) + (Math.log(target.zoom) - Math.log(current.zoom)) * k;
  return {
    camera: { x: current.x + dx * k, y: current.y + dy * k, zoom: Math.exp(lz) },
    done: false,
  };
}

// ---------------------------------------------------------------------------
// inertia
// ---------------------------------------------------------------------------

/** Screen px per millisecond. */
export interface Velocity {
  vx: number;
  vy: number;
}

/** A pointer position with its timestamp, in ms. */
export interface Sample {
  x: number;
  y: number;
  t: number;
}

/** Per-frame multiplier of a thrown pan's speed. */
export const INERTIA_DECAY = 0.95;
/** A release slower than this, in px per frame, is a stop and not a throw. */
export const INERTIA_START_PX = 2;
/** Under this, in px per frame, the glide is not worth another repaint. */
const INERTIA_STOP_PX = 0.5;

/**
 * The velocity over the samples of the last `windowMs`, or `null` when there
 * is nothing to measure. Only the tail of the gesture counts: a pan that
 * dragged slowly for a second and then flicked should fly, and a pan that
 * flew and then stopped still should not.
 */
export function averageVelocity(samples: readonly Sample[], windowMs = 100): Velocity | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  let i = samples.length - 1;
  while (i > 0 && last.t - samples[i - 1].t <= windowMs) i -= 1;
  const first = samples[i];
  const dt = last.t - first.t;
  if (!(dt > 0)) return null;
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/** The velocity after `elapsedMs` of decay, frame-rate independent. */
export function decayVelocity(
  v: Velocity,
  elapsedMs: number,
  decayPerFrame = INERTIA_DECAY,
): Velocity {
  const k = decayPerFrame ** (Math.max(0, elapsedMs) / FRAME_MS);
  return { vx: v.vx * k, vy: v.vy * k };
}

function pxPerFrame(v: Velocity): number {
  return Math.hypot(v.vx, v.vy) * FRAME_MS;
}

/** Fast enough to keep gliding. */
export function inertiaAlive(v: Velocity): boolean {
  return pxPerFrame(v) >= INERTIA_STOP_PX;
}

/** Fast enough at release to start gliding at all. */
export function inertiaWorthStarting(v: Velocity | null): v is Velocity {
  return !!v && pxPerFrame(v) > INERTIA_START_PX;
}
