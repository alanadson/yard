/**
 * Publishes an element's rectangle to `occludersStore` while it is mounted.
 *
 * Who needs this: everything the app floats *over* the canvas. A portal's
 * page is an OS window stacked on top of the DOM, so the toolbar, the
 * minimap, the zoom control and a toast are all invisible — and unclickable —
 * behind a portal card that happens to sit under them. Publishing the
 * rectangle has the engine cut a hole in the page exactly there.
 *
 * The rectangle is re-read when the element resizes (a flyout opening) and
 * when the window does (everything here is anchored to an edge).
 */
import { useLayoutEffect, type RefObject } from "react";

import { useOccluders } from "../stores/occludersStore";

export function useOccluder(
  key: string,
  ref: RefObject<HTMLElement | null>,
  active = true,
): void {
  useLayoutEffect(() => {
    const set = useOccluders.getState().setOccluder;
    const el = ref.current;
    if (!active || !el) {
      set(key, null);
      return;
    }
    const publish = () => {
      const r = el.getBoundingClientRect();
      set(
        key,
        r.width > 0 && r.height > 0
          ? { x: r.left, y: r.top, w: r.width, h: r.height }
          : null,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
      set(key, null);
    };
  }, [key, active, ref]);
}
