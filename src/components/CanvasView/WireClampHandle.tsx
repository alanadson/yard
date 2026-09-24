import { useRef } from "react";
import type { WireClamp } from "../../lib/wireClamps";
import { useT } from "../../hooks/useT";

export type ClampPhase = "live" | "commit" | "cancel";

export function WireClampHandle({
  clamp,
  zoom,
  onMove,
  onRelease,
}: {
  clamp: WireClamp;
  zoom: number;
  onMove: (clamp: WireClamp, phase: ClampPhase) => void;
  onRelease: (id: string) => void;
}) {
  const t = useT();
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    start: WireClamp;
  } | null>(null);
  const position = (e: React.PointerEvent) => {
    const from = drag.current;
    return from
      ? {
          id: clamp.id,
          x: from.start.x + (e.clientX - from.x) / zoom,
          y: from.start.y + (e.clientY - from.y) / zoom,
        }
      : clamp;
  };
  return (
    <g
      className="cv-wire-clamp"
      tabIndex={0}
      role="group"
      aria-label={t(
        "Prendedor de cabos: arraste ou use as setas; Delete solta os cabos.",
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          pointer: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          start: clamp,
        };
      }}
      onPointerMove={(e) => {
        if (drag.current?.pointer !== e.pointerId) return;
        e.stopPropagation();
        onMove(position(e), "live");
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointer !== e.pointerId) return;
        e.stopPropagation();
        const next = position(e);
        drag.current = null;
        onMove(next, "commit");
      }}
      onPointerCancel={() => {
        drag.current = null;
        onMove(clamp, "cancel");
      }}
      onKeyDown={(e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          e.stopPropagation();
          onRelease(clamp.id);
          return;
        }
        const directions: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        const direction = directions[e.key];
        if (direction) {
          e.preventDefault();
          e.stopPropagation();
          const step = (e.shiftKey ? 1 : 10) / zoom;
          onMove(
            {
              ...clamp,
              x: clamp.x + direction[0] * step,
              y: clamp.y + direction[1] * step,
            },
            "commit",
          );
        }
      }}
    >
      <circle
        cx={clamp.x}
        cy={clamp.y}
        r={8 / zoom}
        fill="var(--bg-raised)"
        stroke="var(--text-dim)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        pointerEvents="all"
      />
      <path
        d={`M ${clamp.x - 3 / zoom} ${clamp.y - 3 / zoom} L ${clamp.x + 3 / zoom} ${clamp.y + 3 / zoom} M ${clamp.x + 3 / zoom} ${clamp.y - 3 / zoom} L ${clamp.x - 3 / zoom} ${clamp.y + 3 / zoom}`}
        stroke="var(--text)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
    </g>
  );
}
