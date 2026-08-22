/**
 * The slack in a wire — the part that is motion, not geometry.
 *
 * `connectionGeometry` draws the cable at rest, and a bézier moves exactly
 * with its endpoints: drag a card and the whole curve teleports along with
 * it, rigid, which is what makes a flow editor read as a diagram of rods.
 * Here the belly of the curve is a mass hanging on a spring. It lags behind
 * while the card is moving, keeps going when the card stops, swings back
 * past the line, and the swing dies out.
 *
 * The spring is parameterized the way it is felt rather than the way it is
 * written: how fast it swings, and how fast the swinging dissipates.
 */
import type { ConnectionGeom } from "./canvas";

type Cubic = ConnectionGeom["cubic"];

/** Swings per second. Lower = a heavier, lazier cable. */
const WOBBLE_HZ = 2.4;
/**
 * How fast the swing dissipates: 0 never stops, 1 arrives stiff with no
 * swing at all. At 0.38 a wire yanked 100 units swings back 25 the other
 * way, is visibly still in ~0.7s and formally at rest at 1.0s — long enough
 * to read as slack, short enough that nothing is still moving by the time
 * the hand has moved on.
 */
const WOBBLE_DAMPING = 0.38;
/**
 * Ceiling for how far the belly may trail the wire, in world units. A card
 * flung across the canvas would otherwise leave the cable behind in a loop
 * that no longer reads as the same object.
 */
const MAX_SLACK = 120;
/** Below this displacement (world units) and speed (units/s), it is still. */
const POS_EPS = 0.12;
const VEL_EPS = 1.5;

export interface Spring {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** A spring already parked on its target: no swing at birth. */
export function restingSpring(x: number, y: number): Spring {
  return { x, y, vx: 0, vy: 0 };
}

/**
 * The curve's midpoint (`t = 0.5`), which is the point the spring drags
 * around. A uniform displacement of both control points moves it by 3/4 of
 * that displacement — the 6/8 the cubic's basis gives them at the middle.
 */
export function belly(c: Cubic): [number, number] {
  return [
    (c[0] + 3 * c[2] + 3 * c[4] + c[6]) / 8,
    (c[1] + 3 * c[3] + 3 * c[5] + c[7]) / 8,
  ];
}

/**
 * Advances the spring `dt` seconds toward the target. Semi-implicit Euler,
 * stable well past the `dt` a stalled frame can hand us (the driver clamps
 * it anyway). Returns `false` once there is nothing left to animate, which
 * is how the driver knows to drop this wire and stop the loop.
 */
export function stepSpring(s: Spring, tx: number, ty: number, dt: number): boolean {
  const w = 2 * Math.PI * WOBBLE_HZ;
  const k = w * w;
  const c = 2 * WOBBLE_DAMPING * w;

  s.vx += ((tx - s.x) * k - s.vx * c) * dt;
  s.vy += ((ty - s.y) * k - s.vy * c) * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;

  let dx = s.x - tx;
  let dy = s.y - ty;
  const dist = Math.hypot(dx, dy);
  if (dist > MAX_SLACK) {
    const f = MAX_SLACK / dist;
    dx *= f;
    dy *= f;
    s.x = tx + dx;
    s.y = ty + dy;
  }

  if (Math.hypot(dx, dy) <= POS_EPS && Math.hypot(s.vx, s.vy) <= VEL_EPS) {
    // Snap, so the last frame drawn is exactly the geometry at rest.
    s.x = tx;
    s.y = ty;
    s.vx = 0;
    s.vy = 0;
    return false;
  }
  return true;
}

/**
 * The wire's `d`, with its belly pulled by (`ox`, `oy`). The endpoints never
 * move — the cable stays plugged into both cards, only the slack between
 * them changes. With no offset this is character-for-character the `d` that
 * `connectionGeometry` builds, so the handoff between React's render and the
 * frames written here is seamless.
 */
export function cablePath(c: Cubic, ox: number, oy: number): string {
  const kx = (ox * 4) / 3;
  const ky = (oy * 4) / 3;
  return `M ${c[0]} ${c[1]} C ${c[2] + kx} ${c[3] + ky}, ${c[4] + kx} ${c[5] + ky}, ${c[6]} ${c[7]}`;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

/** Advances one wire. Returns `false` when it has come to rest. */
type Tick = (dt: number) => boolean;

const live = new Set<Tick>();
let raf = 0;
let last = -1;

function pump(now: number) {
  const dt = last < 0 ? 1 / 60 : Math.min((now - last) / 1000, 1 / 30);
  last = now;
  // Copy: a tick that comes to rest removes itself mid-iteration.
  for (const tick of [...live]) {
    if (!tick(dt)) live.delete(tick);
  }
  raf = live.size ? requestAnimationFrame(pump) : 0;
  if (!raf) last = -1;
}

/**
 * Puts a wire on the clock. One `requestAnimationFrame` drives every wire
 * on the canvas — a loop per wire would mean a dozen callbacks fighting for
 * the same frame during a drag, each with its own idea of `dt`.
 */
export function wake(tick: Tick): void {
  live.add(tick);
  if (!raf) raf = requestAnimationFrame(pump);
}

/** Takes a wire off the clock (it was deleted, or the canvas unmounted). */
export function sleep(tick: Tick): void {
  live.delete(tick);
  if (!live.size && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
    last = -1;
  }
}

/** Someone who asked for less motion gets a rigid wire, not a slack one. */
export function motionAllowed(): boolean {
  return typeof matchMedia === "function"
    ? !matchMedia("(prefers-reduced-motion: reduce)").matches
    : true;
}
