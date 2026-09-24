import {
  itemBounds,
  resizeRect,
  type Box,
  type CanvasItem,
  type ResizeDir,
} from "./canvas";
import { toggleMaximize } from "./cardChrome";

export type BoxItem = Extract<CanvasItem, { w: number; h: number }>;

export function isBoxItem(item: CanvasItem): item is BoxItem {
  return "w" in item && "h" in item;
}

/** Native portal surfaces must not paint through the enlarged foreground item. */
export function coveredByMaximizedItem(
  items: readonly CanvasItem[],
  portalId: string,
): boolean {
  return items.some(
    (item) => item.id !== portalId && isBoxItem(item) && !!item.restore,
  );
}

/** Preserve content and metadata while sharing terminal enlargement geometry. */
export function toggleItemMaximize(
  item: CanvasItem,
  view: Box,
  zoom: number,
): CanvasItem {
  if (!isBoxItem(item) || item.pinned) return item;
  const { restore: _restore, ...rest } = item;
  return { ...rest, ...toggleMaximize(item, view, zoom) };
}

export function resizeVectorItem(
  item: CanvasItem,
  dir: ResizeDir,
  dx: number,
  dy: number,
): CanvasItem {
  if (item.pinned || (dx === 0 && dy === 0)) return item;
  if (item.type === "line" || item.type === "arrow") {
    const start = itemBounds(item, () => undefined)!;
    const next = resizeRect(start, dir, dx, dy, 1, 1);
    const x = (value: number) =>
      next.x + ((value - start.x) * next.w) / Math.max(1, start.w);
    const y = (value: number) =>
      next.y + ((value - start.y) * next.h) / Math.max(1, start.h);
    return {
      ...item,
      x1: x(item.x1),
      y1: y(item.y1),
      x2: x(item.x2),
      y2: y(item.y2),
    };
  }
  if (item.type === "stroke") {
    const start = itemBounds(item, () => undefined)!;
    const next = resizeRect(start, dir, dx, dy, 1, 1);
    return {
      ...item,
      points: item.points.map((point, index) =>
        index % 2 === 0
          ? next.x + ((point - start.x) * next.w) / Math.max(1, start.w)
          : next.y + ((point - start.y) * next.h) / Math.max(1, start.h),
      ),
    };
  }
  if (item.type !== "rect" && item.type !== "ellipse") return item;
  return { ...item, ...resizeRect(item, dir, dx, dy, 1, 1) };
}
