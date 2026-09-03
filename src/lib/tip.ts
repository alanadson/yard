/**
 * The in-world tooltip's rules: what a control asks for, where the balloon
 * goes, and when it shows.
 *
 * The balloon itself is one fixed element in `<body>` (`tipLayer.ts`), and
 * this file is the part of it that can be reasoned about with numbers: the
 * old CSS `::after` on the control was clipped by any scrollport it lived in
 * and covered by any panel painted after its stacking context, and the
 * `data-tip-at` hints were a hand-placed guess at the window edge. Here the
 * edge is measured. The attributes stay the same, so the ~400 controls that
 * carry a `data-tip` did not change.
 */

export type TipSide = "bottom" | "top" | "right" | "left";
export type TipAt = "center" | "left" | "right";

export interface TipRequest {
  text: string;
  side: TipSide;
  at: TipAt;
  wrap: boolean;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  side: TipSide;
}

/** The pause before the balloon opens (ms): a hint, not a flash on every pass. */
export const TIP_DELAY = 500;
/** Breathing room kept between the balloon and the window edge (px). */
export const TIP_MARGIN = 6;

const SIDES: readonly TipSide[] = ["bottom", "top", "right", "left"];
const ATS: readonly TipAt[] = ["center", "left", "right"];

/** What the control asks for, or `null` when it has nothing to say. */
export function tipRequest(el: { getAttribute(name: string): string | null }): TipRequest | null {
  const text = el.getAttribute("data-tip");
  if (!text || !text.trim()) return null;
  const side = el.getAttribute("data-tip-side") as TipSide | null;
  const at = el.getAttribute("data-tip-at") as TipAt | null;
  return {
    text,
    side: side && SIDES.includes(side) ? side : "bottom",
    at: at && ATS.includes(at) ? at : "center",
    wrap: el.getAttribute("data-tip-wrap") !== null,
  };
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/**
 * Where the balloon goes. The box measured for `tip` already includes the
 * transparent bridge on the side that faces the control, so the balloon sits
 * flush against the control's edge: prefers the asked side, flips to the
 * opposite one when that would leave the window (and the other side would
 * not), and slides along the other axis to stay inside the margins.
 */
export function placeTip(
  anchor: Box,
  tip: Size,
  viewport: Size,
  prefs: { side: TipSide; at: TipAt },
): Placement {
  const m = TIP_MARGIN;
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const maxX = viewport.width - m - tip.width;
  const maxY = viewport.height - m - tip.height;

  if (prefs.side === "right" || prefs.side === "left") {
    let side = prefs.side;
    if (side === "right" && right > maxX && anchor.left - tip.width >= m) side = "left";
    else if (side === "left" && anchor.left - tip.width < m && right <= maxX) side = "right";
    const x = side === "right" ? right : anchor.left - tip.width;
    const y = clamp(anchor.top + anchor.height / 2 - tip.height / 2, m, maxY);
    return { x, y, side };
  }

  let side = prefs.side;
  if (side === "bottom" && bottom > maxY && anchor.top - tip.height >= m) side = "top";
  else if (side === "top" && anchor.top - tip.height < m && bottom <= maxY) side = "bottom";
  const y = side === "bottom" ? bottom : anchor.top - tip.height;
  const wanted =
    prefs.at === "left"
      ? anchor.left
      : prefs.at === "right"
        ? right - tip.width
        : anchor.left + anchor.width / 2 - tip.width / 2;
  return { x: clamp(wanted, m, maxX), y, side };
}

/**
 * The balloon's state. `A` is whatever identifies the control (the element,
 * in the app); it is generic so the machine can be driven with plain values.
 *
 * `dismissed` is "closed, and stays closed while the pointer rests on this
 * control": after an Esc or a click there is nothing left to say until the
 * pointer, or the focus, moves on to something else.
 */
export type TipState<A> =
  | { phase: "idle" }
  | { phase: "armed"; anchor: A }
  | { phase: "open"; anchor: A }
  | { phase: "dismissed"; anchor: A };

export type TipEvent<A> =
  /** The pointer is over `anchor` (a control with a hint), the balloon, or nothing. */
  | { type: "arrive"; anchor: A | null; inBalloon: boolean; buttons: number }
  /** The pointer left the window. */
  | { type: "leave" }
  /** Keyboard focus landed on `anchor` (a control with a hint). */
  | { type: "focus"; anchor: A }
  /** Keyboard focus left `anchor`. */
  | { type: "blur"; anchor: A }
  /** The opening delay elapsed. */
  | { type: "timer" }
  /** Esc, a press, a scroll, a resize: close, and stay closed on this control. */
  | { type: "close" };

const IDLE = { phase: "idle" } as const;

/** One step of the machine; returns the same object when nothing changes. */
export function tipStep<A>(state: TipState<A>, event: TipEvent<A>): TipState<A> {
  const anchor = state.phase === "idle" ? null : state.anchor;
  switch (event.type) {
    case "arrive": {
      if (event.inBalloon && state.phase === "open") return state;
      if (event.anchor === null) return IDLE;
      // A held button is a drag in progress: nothing opens under it.
      if (event.buttons !== 0) return IDLE;
      if (event.anchor === anchor) return state;
      return { phase: "armed", anchor: event.anchor };
    }
    case "leave":
      return IDLE;
    case "focus":
      // Focus arriving is a fresh intent, so it also releases an Esc.
      if (event.anchor === anchor && state.phase !== "dismissed") return state;
      return { phase: "armed", anchor: event.anchor };
    case "blur":
      return event.anchor === anchor ? IDLE : state;
    case "timer":
      return state.phase === "armed" ? { phase: "open", anchor: state.anchor } : state;
    case "close":
      return anchor === null ? IDLE : { phase: "dismissed", anchor };
  }
}
