/**
 * Draggable divider for the sidebars.
 *
 * Sits absolutely on the pane edge (so the parent must be
 * `position: relative`), captures the pointer so the drag is not lost when
 * it crosses the xterm, and only writes the preference on release —
 * dragging would write dozens of kv rows per second.
 *
 * Also responds to the keyboard: when focused, arrows adjust 16 px at a
 * time (48 with Shift). Double-click returns to the default.
 */
import { useRef, useState, type PointerEvent, type KeyboardEvent } from "react";

interface Props {
  /** Which pane edge the divider lives on. */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  label: string;
  /** During the drag — updates the screen without persisting. */
  onResize: (width: number) => void;
  /** On release — persists. */
  onCommit: (width: number) => void;
}

export function Resizer({
  side,
  width,
  min,
  max,
  defaultWidth,
  label,
  onResize,
  onCommit,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width: 0 });

  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

  // A right-side divider grows as the mouse moves right; a left-side one,
  // the opposite.
  const widthAt = (clientX: number) => {
    const delta = clientX - origin.current.x;
    return clamp(origin.current.width + (side === "right" ? delta : -delta));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    origin.current = { x: e.clientX, width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    onResize(widthAt(e.clientX));
  };

  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    onCommit(widthAt(e.clientX));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? 48 : 16) * (e.key === "ArrowLeft" ? -1 : 1);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onCommit(clamp(width + (side === "right" ? step : -step)));
    }
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
