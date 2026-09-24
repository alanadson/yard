import type { CanvasItem } from "./canvas";

export interface WireClamp {
  id: string;
  x: number;
  y: number;
}

export function copyWireRouting(
  items: CanvasItem[],
  dx: number,
  dy: number,
  createId: () => string,
): CanvasItem[] {
  const ids = new Map<string, string>();
  return items.map((item) => {
    if (item.type !== "connection" || !item.clamp) return item;
    const anchor = item.clamp;
    if (!ids.has(anchor.id)) ids.set(anchor.id, createId());
    return {
      ...item,
      clamp: { id: ids.get(anchor.id)!, x: anchor.x + dx, y: anchor.y + dy },
    };
  });
}

export function positionClamp(
  items: CanvasItem[],
  id: string,
  at: { x: number; y: number } | undefined,
): CanvasItem[] {
  return items.map((item) => {
    if (item.type !== "connection" || item.clamp?.id !== id) return item;
    const { clamp: _old, ...wire } = item;
    return at ? { ...wire, clamp: { id, ...at } } : wire;
  });
}

export function bundleWires(
  items: CanvasItem[],
  selected: ReadonlySet<string>,
  clamp: WireClamp,
): CanvasItem[] {
  if (
    items.filter((item) => item.type === "connection" && selected.has(item.id))
      .length < 2
  )
    return items;
  return items.map((item) =>
    item.type === "connection" && selected.has(item.id)
      ? { ...item, clamp: { ...clamp } }
      : item,
  );
}
