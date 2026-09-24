import type { Box, CanvasData, CanvasItem, CanvasViewport } from "./canvas";

export type DockSide = "left" | "right";

export function undockCopy<T extends { dock?: DockSide }>(card: T): T {
  const { dock: _side, ...copy } = card;
  return copy as T;
}

export function dockWorldRect(
  side: DockSide,
  viewport: CanvasViewport,
  size: { w: number; h: number },
): Box {
  const width = Math.max(1, Math.min(400, (size.w - 80) / 2));
  return {
    x:
      viewport.x + (side === "left" ? 56 : size.w - 12 - width) / viewport.zoom,
    y: viewport.y + 12 / viewport.zoom,
    w: width / viewport.zoom,
    h: Math.max(1, size.h - 24) / viewport.zoom,
  };
}

export function canDock(item: CanvasItem): boolean {
  return ["note", "portal", "tree", "binder", "doc", "media"].includes(
    item.type,
  );
}

export function setDock(
  canvas: CanvasData,
  id: string,
  dock: DockSide | undefined,
  initial?: Box,
): CanvasData {
  const target = canvas.items.find((item) => item.id === id);
  if (target && !canDock(target)) return canvas;
  if (!canvas.nodes[id] && !target && !initial) return canvas;
  const nodes: CanvasData["nodes"] =
    !canvas.nodes[id] && !target && initial
      ? { ...canvas.nodes, [id]: initial }
      : canvas.nodes;
  const change = <T extends { dock?: DockSide }>(
    item: T,
    itemId: string,
  ): T => {
    if (itemId !== id && (!dock || item.dock !== dock)) return item;
    const { dock: _old, ...rest } = item;
    return (itemId === id && dock ? { ...rest, dock } : rest) as T;
  };
  return {
    ...canvas,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([key, node]) => [key, change(node, key)]),
    ),
    items: canvas.items.map((item) => change(item, item.id)),
  };
}
