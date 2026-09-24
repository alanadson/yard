/**
 * Where the world lands on the minimap.
 *
 * Split in two on purpose: `contentBounds` walks every box and changes only
 * when the boxes do; `mapFrame` is constant work per camera frame. While the
 * camera stays inside the board the frame comes out identical, so the card
 * rectangles drawn from it can be reused as they are.
 */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** World to map: `offX + (x - minX) * scale`, and the same for y. */
export interface MapFrame {
  minX: number;
  minY: number;
  scale: number;
  offX: number;
  offY: number;
}

/** Slack around the content so a card at the edge is not drawn on the border. */
const PAD = 0.06;

export function contentBounds(boxes: readonly Rect[]): Bounds | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The camera rectangle is part of the extent on purpose: panning into empty
 * space has to keep the viewport box visible, otherwise the one control that
 * tells you "you are far from everything" scrolls itself out of the map.
 */
export function mapFrame(
  content: Bounds | null,
  cam: Rect,
  size: { w: number; h: number },
): MapFrame {
  let minX = cam.x;
  let minY = cam.y;
  let maxX = cam.x + cam.w;
  let maxY = cam.y + cam.h;
  if (content) {
    minX = Math.min(minX, content.minX);
    minY = Math.min(minY, content.minY);
    maxX = Math.max(maxX, content.maxX);
    maxY = Math.max(maxY, content.maxY);
  }
  const padX = (maxX - minX) * PAD || 40;
  const padY = (maxY - minY) * PAD || 40;
  minX -= padX;
  minY -= padY;
  maxX += padX;
  maxY += padY;

  const scale = Math.min(size.w / (maxX - minX), size.h / (maxY - minY));
  // Centered inside the little box, so a tall board does not hug the left edge.
  return {
    minX,
    minY,
    scale,
    offX: (size.w - (maxX - minX) * scale) / 2,
    offY: (size.h - (maxY - minY) * scale) / 2,
  };
}
