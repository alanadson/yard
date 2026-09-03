/**
 * The board seen from above.
 *
 * An infinite canvas has one native failure mode: you zoom into a card, drag
 * twice, and the other six agents are somewhere off-screen with no arrow
 * pointing at them. "Enquadrar tudo" solves it by throwing the camera away;
 * the minimap solves it without moving the camera at all — you can see where
 * everything is *while* staying zoomed in, and click to go there.
 *
 * It renders in its own coordinate space (world scaled down to fit the little
 * box), so it costs one `<svg>` of `<rect>`s per frame of a camera move and
 * nothing else: no DOM per card, no xterm, no portal.
 */
import { memo, useCallback, useRef } from "react";

import type { CanvasViewport } from "../../lib/canvas";
import { useT } from "../../hooks/useT";

export type MiniKind = "terminal" | "note" | "portal" | "draw";

export interface MiniBox {
  id: string;
  kind: MiniKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A terminal running an agent paints in the agent's own colour. */
  color?: string;
}

interface Props {
  boxes: MiniBox[];
  vp: CanvasViewport;
  /** Size of the canvas viewport, in screen px. */
  view: { w: number; h: number };
  selection: ReadonlySet<string>;
  /** Puts this world point at the center of the camera. */
  onJump: (x: number, y: number) => void;
  onClose: () => void;
}

const MAP_W = 188;
const MAP_H = 118;
/** Slack around the content so a card at the edge is not drawn on the border. */
const PAD = 0.06;

function MinimapImpl({ boxes, vp, view, selection, onJump, onClose }: Props) {
  const t = useT();
  const svgRef = useRef<SVGSVGElement>(null);
  // The rectangle this floater publishes so a portal underneath does not
  // paint the site over it is `.cv-camera`'s, one level up: the map is a
  // piece of that pane now, never a floater on its own (see CanvasView).
  const dragging = useRef(false);

  // The camera rectangle is part of the extent on purpose: panning into empty
  // space has to keep the viewport box visible, otherwise the one control that
  // tells you "you are far from everything" scrolls itself out of the map.
  const cam = { x: vp.x, y: vp.y, w: view.w / vp.zoom, h: view.h / vp.zoom };
  let minX = cam.x;
  let minY = cam.y;
  let maxX = cam.x + cam.w;
  let maxY = cam.y + cam.h;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const padX = (maxX - minX) * PAD || 40;
  const padY = (maxY - minY) * PAD || 40;
  minX -= padX;
  minY -= padY;
  maxX += padX;
  maxY += padY;

  const scale = Math.min(MAP_W / (maxX - minX), MAP_H / (maxY - minY));
  // Centered inside the little box, so a tall board does not hug the left edge.
  const offX = (MAP_W - (maxX - minX) * scale) / 2;
  const offY = (MAP_H - (maxY - minY) * scale) / 2;
  const sx = (v: number) => offX + (v - minX) * scale;
  const sy = (v: number) => offY + (v - minY) * scale;

  const jumpFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return;
      onJump(
        minX + (clientX - r.left - offX) / scale,
        minY + (clientY - r.top - offY) / scale,
      );
    },
    [minX, minY, offX, offY, onJump, scale],
  );

  return (
    <div className="cv-minimap">
      <svg
        ref={svgRef}
        width={MAP_W}
        height={MAP_H}
        role="presentation"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          dragging.current = true;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          jumpFromEvent(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          jumpFromEvent(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        }}
      >
        {boxes.map((b) => (
          <rect
            key={b.id}
            className={`cv-mini-box cv-mini-box--${b.kind} ${
              selection.has(b.id) ? "is-selected" : ""
            }`}
            x={sx(b.x)}
            y={sy(b.y)}
            // Nothing may collapse to a hairline: a pen stroke drawn in a
            // straight line has zero height in world units and would vanish
            // from the one view that exists to prove it is there.
            width={Math.max(2, b.w * scale)}
            height={Math.max(2, b.h * scale)}
            rx={3}
            style={b.color ? { fill: b.color } : undefined}
          />
        ))}
        <rect
          className="cv-mini-cam"
          x={sx(cam.x)}
          y={sy(cam.y)}
          width={Math.max(4, cam.w * scale)}
          height={Math.max(4, cam.h * scale)}
          rx={6}
        />
      </svg>
      <button
        className="cv-mini-close"
        data-tip-side="left"
        data-tip={t("Esconder o minimapa (Ctrl+Shift+M)")}
        aria-label={t("Esconder o minimapa")}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

export const Minimap = memo(MinimapImpl);
