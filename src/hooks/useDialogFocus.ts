/**
 * Focus for the surfaces that cover the whole window (code editor, diff).
 *
 * `Modal` had always done this; the two large overlays were `role="dialog"`
 * on paper and a `<div>` in practice — no `aria-modal`, no Tab trap and no
 * focus restore. What actually happened was that the keyboard slipped out
 * under the overlay and wandered through the title-bar and canvas buttons
 * hidden behind it, with nothing on screen showing where it was.
 *
 * What this hook does **not** do is steal Tab from whoever already uses it:
 * CodeMirror indents with Tab and marks the key as handled, so the
 * `defaultPrevented` check leaves the text surface alone.
 */
import { useEffect, type RefObject } from "react";

import { isTopLayer, type Layer } from "../lib/layers";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  layer: Layer,
) {
  // Give focus back to whoever opened the surface.
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      if (!isTopLayer(layer)) return;
      const root = ref.current;
      if (!root) return;

      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const currentValue = document.activeElement;

      if (!root.contains(currentValue)) {
        // Focus escaped (click outside, element removed): bring it back.
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (currentValue === first || currentValue === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && currentValue === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, layer, ref]);
}
