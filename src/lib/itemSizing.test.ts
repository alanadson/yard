// Canvas media needs the same reversible enlargement as terminals, without changing its source.
import { expect, it } from "vitest";
import { normalizeCanvas, reconcileItems, type CanvasItem } from "./canvas";
import {
  coveredByMaximizedItem,
  resizeVectorItem,
  toggleItemMaximize,
} from "./itemSizing";

it("enlarges an image to the visible canvas and restores its exact original rectangle", () => {
  const item: CanvasItem = {
    id: "image",
    type: "media",
    path: "design.png",
    color: "#fff",
    x: 42,
    y: 75,
    w: 320,
    h: 240,
  };
  const enlarged = toggleItemMaximize(
    item,
    { x: 100, y: 200, w: 1200, h: 800 },
    2,
  );
  expect(enlarged).toMatchObject({
    x: 110,
    y: 210,
    w: 1180,
    h: 780,
    path: "design.png",
    restore: { x: 42, y: 75, w: 320, h: 240 },
  });
  expect(
    toggleItemMaximize(enlarged, { x: 999, y: 999, w: 800, h: 600 }, 1),
  ).toEqual(item);
});

it("leaves pinned items in place when enlargement is requested", () => {
  const item: CanvasItem = {
    id: "note",
    type: "note",
    text: "Keep here",
    color: "#fff",
    pinned: true,
    x: 42,
    y: 75,
    w: 320,
    h: 240,
  };
  expect(toggleItemMaximize(item, { x: 0, y: 0, w: 1200, h: 800 }, 1)).toBe(
    item,
  );
});

it("discards invalid restore rectangles when loading a saved image", () => {
  const item = {
    id: "image",
    type: "media",
    path: "design.png",
    color: "#fff",
    x: 42,
    y: 75,
    w: 320,
    h: 240,
    restore: { x: 0, y: 0, w: -10, h: 100 },
  };
  const loaded = normalizeCanvas({ items: [item] })!.items[0];
  expect(loaded.restore).toBeUndefined();
});

it("resizes a drawn shape from its corner while anchoring the opposite corner", () => {
  const item: CanvasItem = {
    id: "shape",
    type: "rect",
    color: "#fff",
    size: "m",
    seed: 1,
    x: 100,
    y: 100,
    w: 200,
    h: 100,
  };
  expect(resizeVectorItem(item, "nw", -50, -25)).toMatchObject({
    x: 50,
    y: 75,
    w: 250,
    h: 125,
  });
});

it("scales every point of a freehand drawing into the resized rectangle", () => {
  const item: CanvasItem = {
    id: "drawing",
    type: "stroke",
    color: "#fff",
    size: "m",
    points: [10, 20, 30, 40, 50, 60],
  };
  expect(resizeVectorItem(item, "se", 40, 80)).toMatchObject({
    points: [10, 20, 50, 80, 90, 140],
  });
});

it("resizes arrows without reversing their endpoint direction", () => {
  const item: CanvasItem = {
    id: "arrow",
    type: "arrow",
    color: "#fff",
    size: "m",
    seed: 2,
    x1: 200,
    y1: 100,
    x2: 100,
    y2: 150,
  };
  expect(resizeVectorItem(item, "se", 100, 50)).toMatchObject({
    x1: 300,
    y1: 100,
    x2: 100,
    y2: 200,
  });
});

it("does not create a resize edit when the pointer has not moved", () => {
  const item: CanvasItem = {
    id: "line",
    type: "line",
    color: "#fff",
    size: "m",
    seed: 2,
    x1: 100,
    y1: 100,
    x2: 200,
    y2: 100,
  };
  expect(resizeVectorItem(item, "se", 0, 0)).toBe(item);
});

it("keeps pinned drawings unchanged by resize gestures", () => {
  const item: CanvasItem = {
    id: "line",
    type: "line",
    color: "#fff",
    size: "m",
    seed: 2,
    x1: 100,
    y1: 100,
    x2: 200,
    y2: 100,
  };
  const pinned = { ...item, pinned: true };
  expect(resizeVectorItem(pinned, "se", 100, 50)).toBe(pinned);
});

it("updates the restore control even when a card already fills the visible canvas", () => {
  const item: CanvasItem = {
    id: "image",
    type: "media",
    path: "design.png",
    color: "#fff",
    x: 20,
    y: 20,
    w: 1160,
    h: 760,
  };
  const enlarged = toggleItemMaximize(item, { x: 0, y: 0, w: 1200, h: 800 }, 1);
  expect(reconcileItems([item], [enlarged])[0].restore).toEqual({
    x: 20,
    y: 20,
    w: 1160,
    h: 760,
  });
});

it("covers native browsers while another canvas item is enlarged", () => {
  const portal: CanvasItem = {
    id: "portal",
    type: "portal",
    url: "about:blank",
    color: "#fff",
    x: 0,
    y: 0,
    w: 640,
    h: 480,
  };
  const image: CanvasItem = {
    id: "image",
    type: "media",
    path: "design.png",
    color: "#fff",
    x: 20,
    y: 20,
    w: 320,
    h: 240,
  };
  const enlarged = toggleItemMaximize(
    image,
    { x: 0, y: 0, w: 1200, h: 800 },
    1,
  );
  expect(coveredByMaximizedItem([portal, enlarged], portal.id)).toBe(true);
  expect(coveredByMaximizedItem([portal, image], portal.id)).toBe(false);
  expect(
    coveredByMaximizedItem(
      [toggleItemMaximize(portal, { x: 0, y: 0, w: 1200, h: 800 }, 1)],
      portal.id,
    ),
  ).toBe(false);
});
