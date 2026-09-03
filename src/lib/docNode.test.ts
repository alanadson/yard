/**
 * A source file pinned to the board next to the agent editing it. The card
 * is an address (root + relative path), the same shape as a media card, so a
 * score applied in another checkout still opens the right file.
 */
import { describe, expect, it } from "vitest";

import { hitItem, itemBounds, normalizeCanvas, translateItem, type CanvasItem } from "./canvas";
import { DOC_DEFAULT_H, DOC_DEFAULT_W, DOC_MIN_H, DOC_MIN_W, docBoxAt, docNodeName } from "./docNode";

const doc: CanvasItem = {
  id: "d1",
  type: "doc",
  x: 10,
  y: 20,
  w: 560,
  h: 420,
  path: "src/lib/canvas.ts",
  color: "#fff",
};

describe("the doc item", () => {
  it("survives a round trip through normalizeCanvas", () => {
    const out = normalizeCanvas({ viewport: { x: 0, y: 0, zoom: 1 }, nodes: {}, items: [doc] })!;
    expect(out.items[0]).toMatchObject({ type: "doc", path: "src/lib/canvas.ts" });
  });

  it("keeps a root of its own and a pinned name, and cuts the name to size", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [{ ...doc, root: "D:\\refs\\", name: "x".repeat(90) }],
    })!;
    const it = out.items[0] as Extract<CanvasItem, { type: "doc" }>;
    expect(it.root).toBe("D:/refs/");
    expect(it.name!.length).toBeLessThan(90);
  });

  it("is dropped when it carries no path", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [{ ...doc, path: "  " }],
    })!;
    expect(out.items).toEqual([]);
  });

  it("never shrinks below its minimum", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [{ ...doc, w: 10, h: 10 }],
    })!;
    expect(out.items[0]).toMatchObject({ w: DOC_MIN_W, h: DOC_MIN_H });
  });

  it("is hit on its body, reports its box and moves as a rectangle", () => {
    expect(hitItem(doc, 100, 100, 0, () => undefined)).toBe(true);
    expect(hitItem(doc, 900, 900, 0, () => undefined)).toBe(false);
    expect(itemBounds(doc, () => undefined)).toEqual({ x: 10, y: 20, w: 560, h: 420 });
    expect(translateItem(doc, 5, 5)).toMatchObject({ x: 15, y: 25 });
  });
});

describe("docNodeName / docBoxAt", () => {
  it("names the card after the file unless a name was pinned", () => {
    expect(docNodeName(doc as Extract<CanvasItem, { type: "doc" }>)).toBe("canvas.ts");
    expect(docNodeName({ ...doc, name: "Modelo" } as Extract<CanvasItem, { type: "doc" }>)).toBe("Modelo");
  });

  it("is born centred on the point, at the default size", () => {
    expect(docBoxAt(1000, 800)).toEqual({
      x: 1000 - DOC_DEFAULT_W / 2,
      y: 800 - DOC_DEFAULT_H / 2,
      w: DOC_DEFAULT_W,
      h: DOC_DEFAULT_H,
    });
  });
});
