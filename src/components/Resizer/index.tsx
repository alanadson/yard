/**
 * Draggable divider for the sidebars.
 *
 * Sits absolutely on the pane edge (so the parent must be
 * `position: relative`), captures the pointer so the drag is not lost when
 * it crosses the xterm, and only reaches the store on release. During the
 * drag the width goes straight to the pane's DOM (the parent, which renders
 * `style={{ width }}`): writing the store on every pointermove re-rendered
 * the whole pane, the sidebar's project tree included, dozens of times per
 * second, and the persisted preference would have been dozens of kv rows.
 *
 * Also responds to the keyboard: when focused, arrows adjust 16 px at a
 * time (48 with Shift). Double-click returns to the default. The arithmetic
 * lives in `size.ts`.
 */
import { useRef, useState, type PointerEvent, type KeyboardEvent } from "react";

import { dragWidth, keyWidth } from "./size";

interface Props {
  /** Which pane edge the divider lives on. */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  label: string;
  /**
   * On release (and on each arrow key or double-click): the one write to the
   * store, which persists. During a drag the width lives only in the DOM.
   */
  onCommit: (width: number) => void;
}

/**
 * Writes a width on the pane this divider sits on, and on the divider's own
 * `aria-valuenow`, without going through React.
 */
function paint(divider: HTMLElement, width: number) {
  const pane = divider.parentElement;
  if (pane) pane.style.width = `${width}px`;
  divider.setAttribute("aria-valuenow", String(width));
}

export function Resizer({
  side,
  width,
  min,
  max,
  defaultWidth,
  label,
  onCommit,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width: 0 });

  const widthAt = (clientX: number) =>
    dragWidth({
      side,
      startX: origin.current.x,
      startWidth: origin.current.width,
      clientX,
      min,
      max,
    });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    origin.current = { x: e.clientX, width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    paint(e.currentTarget, widthAt(e.clientX));
  };

  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    // Hand the DOM back as React last rendered it before the commit: if the
    // store settles on the width it already had (a drag that came back, a
    // clamp), React sees no change and would otherwise leave the painted one.
    paint(e.currentTarget, width);
    onCommit(widthAt(e.clientX));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyWidth({ side, width, key: e.key, shift: e.shiftKey, min, max });
    if (next === null) return;
    e.preventDefault();
    onCommit(next);
  };

  return (
    <div
      className={`resizer resizer--${side} ${dragging ? "is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(defaultWidth)}
    />
  );
}
