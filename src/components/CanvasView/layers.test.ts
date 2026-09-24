// Camera updates must reuse content classification and preserve draw order.
import { expect, it } from "vitest";
import type { CanvasItem } from "../../lib/canvas";
import { partitionItems, selectionOutlines } from "./layers";

it("partitions card and vector layers without changing their stacking order", () => {
  const items: CanvasItem[] = [
    {
      id: "a",
      type: "text",
      x: 0,
      y: 0,
      text: "a",
      fontSize: 16,
      color: "red",
    },
    {
      id: "b",
      type: "stroke",
      points: [0, 0, 10, 10],
      size: "s",
      color: "red",
    },
    {
      id: "c",
      type: "note",
      x: 0,
      y: 0,
      w: 10,
      h: 20,
      text: "c",
      color: "red",
    },
  ];
  const layers = partitionItems(items);
  expect(layers.dom.map((item) => item.id)).toEqual(["a", "c"]);
  expect(layers.vector).toEqual([items[1]]);
  expect(layers.tree).toEqual([]);
  expect(layers.dom[0]).toBe(items[0]);
});

it("moves selected vector outlines with the drag while leaving other items unselected", () => {
  const items: CanvasItem[] = [
    {
      id: "line",
      type: "line",
      color: "red",
      size: "s",
      seed: 1,
      x1: 0,
      y1: 0,
      x2: 20,
      y2: 10,
    },
  ];
  const selection = new Set(["line"]);
  const before = selectionOutlines(items, selection, null);
  const after = selectionOutlines(items, selection, {
    ids: selection,
    dx: 30,
    dy: -5,
  });
  expect(after).toEqual(
    before.map((box) => ({ ...box, x: box.x + 30, y: box.y - 5 })),
  );
  expect(selectionOutlines(items, new Set(), null)).toEqual([]);
});
