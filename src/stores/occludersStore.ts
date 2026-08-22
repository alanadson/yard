/**
 * Screen rectangles of the DOM surfaces that have to paint *over* a portal.
 *
 * A portal's page is an OS window parented to the main window: no z-index
 * reaches it, so anything the app floats on top — a menu, the toolbar, the
 * minimap, a toast — has to say where it is. Each rectangle becomes a hole
 * cut out of the pages it lands on (`PortalPlace.holes`), which takes the
 * mouse with it: what shows through is the real menu, clickable.
 *
 * This started as a single flag, and one open menu anywhere blanked every
 * site on the board; then as a rectangle that hid whole portals. Cutting the
 * page instead costs the few pixels the menu actually covers.
 *
 * The full-screen surfaces (a modal, Ao Vivo, the diff, the editor) keep
 * their own boolean in `CanvasView` — they cover the canvas whole, so there
 * is nothing to intersect and nothing to gain from measuring.
 */
import { create } from "zustand";

/** In CSS pixels, relative to the window — the same space as `getBoundingClientRect`. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OccluderState {
  /** Keyed by the publisher's own id, so unmounts clean up exactly one entry. */
  rects: Record<string, ScreenRect>;
  /** `null` retires the rectangle. */
  setOccluder: (key: string, rect: ScreenRect | null) => void;
}

function sameRect(a: ScreenRect, b: ScreenRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

export const useOccluders = create<OccluderState>()((set) => ({
  rects: {},
  setOccluder: (key, rect) =>
    set((s) => {
      const prev = s.rects[key];
      if (!rect) {
        if (!prev) return s;
        const next = { ...s.rects };
        delete next[key];
        return { rects: next };
      }
      // Identity matters: `rects` is a render dependency of every portal on
      // the board, and a menu that re-measures to the same place must not
      // move a single native surface.
      if (prev && sameRect(prev, rect)) return s;
      return { rects: { ...s.rects, [key]: rect } };
    }),
}));

/**
 * Do two rectangles touch, with `pad` px of slack?
 *
 * The slack covers what the rectangle does not: a menu's shadow, and the
 * couple of pixels a native surface can be off by while a pan is in flight.
 */
export function rectsOverlap(a: ScreenRect, b: ScreenRect, pad = 0): boolean {
  return (
    a.x < b.x + b.w + pad &&
    b.x < a.x + a.w + pad &&
    a.y < b.y + b.h + pad &&
    b.y < a.y + a.h + pad
  );
}
