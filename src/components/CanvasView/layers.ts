import { itemBounds, type CanvasItem } from "../../lib/canvas";

type CardKind =
  "tree" | "binder" | "portal" | "media" | "doc" | "group" | "flow";
type ItemLayers = { [K in CardKind]: Extract<CanvasItem, { type: K }>[] } & {
  dom: Extract<CanvasItem, { type: "text" | "note" }>[];
  vector: CanvasItem[];
};

/** Content classification is independent of camera and viewport visibility. */
export function partitionItems(items: readonly CanvasItem[]): ItemLayers {
  const layers: ItemLayers = {
    tree: [],
    binder: [],
    portal: [],
    media: [],
    doc: [],
    group: [],
    flow: [],
    dom: [],
    vector: [],
  };
  for (const item of items) {
    switch (item.type) {
      case "text":
      case "note":
        layers.dom.push(item);
        break;
      case "tree":
        layers.tree.push(item);
        break;
      case "binder":
        layers.binder.push(item);
        break;
      case "portal":
        layers.portal.push(item);
        break;
      case "media":
        layers.media.push(item);
        break;
      case "doc":
        layers.doc.push(item);
        break;
      case "group":
        layers.group.push(item);
        break;
      case "flow":
        layers.flow.push(item);
        break;
      case "stroke":
      case "rect":
      case "ellipse":
      case "line":
      case "arrow":
        layers.vector.push(item);
        break;
    }
  }
  return layers;
}

export function selectionOutlines(
  items: readonly CanvasItem[],
  selection: ReadonlySet<string>,
  dragDelta: { ids: ReadonlySet<string>; dx: number; dy: number } | null,
) {
  return items.flatMap((it) => {
    if (
      !selection.has(it.id) ||
      it.type === "connection" ||
      it.type === "note" ||
      it.type === "portal" ||
      it.type === "text"
    ) {
      return [];
    }
    const b = itemBounds(it, () => undefined);
    if (!b) return [];
    const shift = dragDelta?.ids.has(it.id) ? dragDelta : null;
    return [
      {
        id: it.id,
        x: b.x + (shift?.dx ?? 0),
        y: b.y + (shift?.dy ?? 0),
        w: b.w,
        h: b.h,
      },
    ];
  });
}
