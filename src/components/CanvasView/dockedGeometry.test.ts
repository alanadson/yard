// Pan and zoom run once per animation frame, and only what is docked to a
// screen edge moves with the camera. Everything else has to come back as the
// very same objects: a fresh map per frame makes every memo downstream (the
// culling, the minimap, the selection outline, the wires) redo its work for a
// board that did not change, and a stroke's bounds walk all of its points.
import { describe, expect, it } from "vitest";
import {
  autoNodeRect,
  itemBounds,
  type Box,
  type CanvasItem,
  type CanvasNode,
  type CanvasViewport,
} from "../../lib/canvas";
import { canDock, dockWorldRect } from "../../lib/canvasDock";
import {
  anchorLayer,
  cameraWhileDocked,
  cardLayer,
  itemBoxLayer,
  placeAnchors,
  placeCards,
  placeItemBoxes,
} from "./dockedGeometry";

const screen = { w: 1000, h: 600 };
const noScreen = { w: 0, h: 0 };
const home: CanvasViewport = { x: 0, y: 0, zoom: 1 };
const panned: CanvasViewport = { x: 340, y: -120, zoom: 0.5 };
const cameras: [CanvasViewport, { w: number; h: number }][] = [
  [home, screen],
  [panned, screen],
  [panned, noScreen],
];

const stroke: CanvasItem = {
  id: "s1",
  type: "stroke",
  points: [10, 20, 40, -5, 25, 60],
  size: "m",
  color: "#fff",
};
const note = (id: string, x: number, dock?: "left" | "right"): CanvasItem => ({
  id,
  type: "note",
  x,
  y: 30,
  w: 250,
  h: 170,
  text: id,
  color: "#fff",
  ...(dock ? { dock } : {}),
});
const binder = (id: string, notes: string[], dock?: "left" | "right"): CanvasItem => ({
  id,
  type: "binder",
  x: 900,
  y: 40,
  w: 320,
  h: 240,
  notes,
  color: "#fff",
  ...(dock ? { dock } : {}),
});
const text: CanvasItem = { id: "t1", type: "text", x: 5, y: 5, text: "hi\nthere", fontSize: 16, color: "#fff" };
const wire: CanvasItem = { id: "c1", type: "connection", from: "agent", to: "n1", color: "#fff" };
const box: CanvasItem = { id: "r1", type: "rect", x: -40, y: -40, w: 30, h: 30, size: "s", seed: 1, color: "#fff" };

/** A board with nothing docked. */
const calm: CanvasItem[] = [stroke, note("n1", 0), text, wire, box, note("n3", 400), binder("b1", ["n3"])];
/** The same board with a note on the left edge and the binder on the right. */
const busy: CanvasItem[] = [
  stroke,
  note("n1", 0),
  note("n2", 600, "left"),
  text,
  wire,
  box,
  note("n3", 400),
  binder("b1", ["n3"], "right"),
];

const filedOf = (items: CanvasItem[]) =>
  new Set(items.flatMap((it) => (it.type === "binder" ? it.notes : [])));

// --- the single-pass memos this module replaced, kept verbatim as the oracle ---

function legacyItemBoxes(
  items: CanvasItem[],
  filed: ReadonlySet<string>,
  vp: CanvasViewport,
  size: { w: number; h: number },
): Record<string, Box> {
  const m: Record<string, Box> = {};
  for (const it of items) {
    if (it.type === "connection") continue;
    if (it.type === "note" && filed.has(it.id)) continue;
    const b = it.dock && canDock(it) ? dockWorldRect(it.dock, vp, size) : itemBounds(it, () => undefined);
    if (b) m[it.id] = b;
  }
  return m;
}

function legacyRects(
  cards: { id: string }[],
  nodes: Record<string, CanvasNode>,
  overrides: Record<string, CanvasNode>,
  autoRects: CanvasNode[],
  vp: CanvasViewport,
  size: { w: number; h: number },
): Record<string, CanvasNode> {
  const m: Record<string, CanvasNode> = {};
  cards.forEach((t, i) => {
    m[t.id] = overrides[t.id] ?? nodes[t.id] ?? autoRects[i];
    if (m[t.id].dock) m[t.id] = { ...m[t.id], ...dockWorldRect(m[t.id].dock!, vp, size), pinned: true };
  });
  return m;
}

type Drag = { ids: ReadonlySet<string>; dx: number; dy: number } | null;
type Resize = { id: string; w: number; h: number } | null;

function legacyAnchors(
  rects: Record<string, CanvasNode>,
  items: CanvasItem[],
  noteDrag: Drag,
  noteResize: Resize,
  vp: CanvasViewport,
  size: { w: number; h: number },
): Record<string, CanvasNode> {
  const m: Record<string, CanvasNode> = { ...rects };
  for (const it of items) {
    if (
      it.type !== "note" &&
      it.type !== "portal" &&
      it.type !== "flow" &&
      it.type !== "binder" &&
      it.type !== "tree" &&
      it.type !== "media" &&
      it.type !== "doc"
    )
      continue;
    const live = noteResize?.id === it.id ? noteResize : null;
    const shift = noteDrag?.ids.has(it.id) ? noteDrag : null;
    m[it.id] = {
      x: it.x + (shift?.dx ?? 0),
      y: it.y + (shift?.dy ?? 0),
      w: live?.w ?? it.w,
      h: live?.h ?? it.h,
    };
  }
  for (const it of items) if (it.dock && canDock(it)) m[it.id] = dockWorldRect(it.dock, vp, size);
  for (const it of items) {
    if (it.type !== "binder") continue;
    const b = m[it.id];
    if (!b) continue;
    for (const id of it.notes) m[id] = b;
  }
  return m;
}

/** Same values AND the same key order: `Object.keys` feeds the connection dialog. */
function expectSameMap<T>(actual: Record<string, T>, expected: Record<string, T>) {
  expect(actual).toEqual(expected);
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
}

describe("item boxes", () => {
  it("hands back the resting map itself when nothing is docked, wherever the camera goes", () => {
    const layer = itemBoxLayer(calm, filedOf(calm));
    expect(placeItemBoxes(layer, home, screen)).toBe(layer.base);
    expect(placeItemBoxes(layer, panned, screen)).toBe(layer.base);
  });

  it("puts a docked item on its screen edge for the camera it is given", () => {
    const layer = itemBoxLayer(busy, filedOf(busy));
    expect(placeItemBoxes(layer, home, screen).n2).toEqual(dockWorldRect("left", home, screen));
    expect(placeItemBoxes(layer, panned, screen).n2).toEqual(dockWorldRect("left", panned, screen));
    expect(placeItemBoxes(layer, panned, screen).b1).toEqual(dockWorldRect("right", panned, screen));
  });

  it("keeps every undocked box as the same object across camera moves, so a stroke is never walked again", () => {
    const layer = itemBoxLayer(busy, filedOf(busy));
    const first = placeItemBoxes(layer, home, screen);
    const second = placeItemBoxes(layer, panned, screen);
    for (const id of ["s1", "n1", "t1", "r1"]) {
      expect(first[id]).toBe(layer.base[id]);
      expect(second[id]).toBe(layer.base[id]);
    }
  });

  it("matches the single-pass computation it replaced, key order included", () => {
    // Two items under one id: the later one wins, docked or not, as it did.
    const twins: CanvasItem[] = [...busy, note("d", 0, "left"), note("d", 70), note("e", 10), note("e", 90, "right")];
    for (const items of [calm, busy, twins]) {
      const filed = filedOf(items);
      const layer = itemBoxLayer(items, filed);
      for (const [vp, size] of cameras) {
        expectSameMap(placeItemBoxes(layer, vp, size), legacyItemBoxes(items, filed, vp, size));
      }
    }
  });
});

describe("card rectangles", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const autoRects = cards.map((_, i) => autoNodeRect(i));
  const nodes: Record<string, CanvasNode> = {
    a: { x: 10, y: 20, w: 600, h: 400, color: "#f00" },
    b: { x: 700, y: 20, w: 600, h: 400, fontSize: 18 },
  };
  const dockedNodes: Record<string, CanvasNode> = { ...nodes, b: { ...nodes.b, dock: "right" } };
  const overrides: Record<string, CanvasNode> = { a: { x: 15, y: 25, w: 600, h: 400 } };

  it("hands back the resting map itself when no card is docked", () => {
    const layer = cardLayer(cards, nodes, overrides, autoRects);
    expect(placeCards(layer, home, screen)).toBe(layer.base);
    expect(placeCards(layer, panned, screen)).toBe(layer.base);
  });

  it("pins a docked card to its edge and keeps the rest of what it paints from", () => {
    const layer = cardLayer(cards, dockedNodes, overrides, autoRects);
    expect(placeCards(layer, panned, screen).b).toEqual({
      ...dockedNodes.b,
      ...dockWorldRect("right", panned, screen),
      pinned: true,
    });
  });

  it("keeps an undocked card as the object it rests on, override and automatic spot alike", () => {
    const layer = cardLayer(cards, dockedNodes, overrides, autoRects);
    const placed = placeCards(layer, panned, screen);
    expect(placed.a).toBe(overrides.a);
    expect(placed.c).toBe(autoRects[2]);
  });

  it("matches the single-pass computation it replaced, key order included", () => {
    for (const n of [nodes, dockedNodes]) {
      const layer = cardLayer(cards, n, overrides, autoRects);
      for (const [vp, size] of cameras) {
        expectSameMap(placeCards(layer, vp, size), legacyRects(cards, n, overrides, autoRects, vp, size));
      }
    }
    // Two cards under one id: the later one's resting spot wins, docked or not.
    const twins = [{ id: "b" }, { id: "b" }, { id: "x" }, { id: "x" }];
    const twinAuto: CanvasNode[] = [
      { ...autoNodeRect(0), dock: "left" },
      autoNodeRect(1),
      autoNodeRect(2),
      { ...autoNodeRect(3), dock: "right" },
    ];
    expectSameMap(
      placeCards(cardLayer(twins, {}, {}, twinAuto), panned, screen),
      legacyRects(twins, {}, {}, twinAuto, panned, screen),
    );
  });
});

describe("connection anchors", () => {
  const rects: Record<string, CanvasNode> = { agent: { x: 0, y: 500, w: 600, h: 400 } };
  const drag: Drag = { ids: new Set(["n1"]), dx: 12, dy: -8 };
  const resize: Resize = { id: "b1", w: 400, h: 300 };

  it("hands back the resting map itself when nothing is docked", () => {
    const layer = anchorLayer(rects, calm, drag, resize);
    expect(placeAnchors(layer, home, screen)).toBe(layer.base);
    expect(placeAnchors(layer, panned, screen)).toBe(layer.base);
  });

  it("lands the wires of a note filed in a docked binder on the binder's edge", () => {
    const layer = anchorLayer(rects, busy, null, null);
    const placed = placeAnchors(layer, panned, screen);
    expect(placed.b1).toEqual(dockWorldRect("right", panned, screen));
    expect(placed.n3).toBe(placed.b1);
  });

  it("keeps undocked anchors as the same objects across camera moves", () => {
    const layer = anchorLayer(rects, busy, drag, null);
    const first = placeAnchors(layer, home, screen);
    const second = placeAnchors(layer, panned, screen);
    for (const id of ["agent", "n1"]) {
      expect(first[id]).toBe(layer.base[id]);
      expect(second[id]).toBe(layer.base[id]);
    }
  });

  it("matches the single-pass computation it replaced, key order included", () => {
    // A docked note that is also filed: the binder's box has to win, as it
    // did when the filed pass ran after the docked one.
    const odd: CanvasItem[] = [...busy, note("n4", 50, "left"), binder("b2", ["n4", "ghost"])];
    for (const items of [calm, busy, odd]) {
      for (const [d, r] of [[null, null], [drag, resize]] as [Drag, Resize][]) {
        const layer = anchorLayer(rects, items, d, r);
        for (const [vp, size] of cameras) {
          expectSameMap(placeAnchors(layer, vp, size), legacyAnchors(rects, items, d, r, vp, size));
        }
      }
    }
  });
});

describe("what a placement is re-run for", () => {
  it("leaves the camera out while nothing is docked, so a pan does not re-run the placement at all", () => {
    const layer = itemBoxLayer(calm, filedOf(calm));
    expect(cameraWhileDocked(layer, home, screen)).toEqual([null, null]);
    expect(cameraWhileDocked(layer, panned, screen)).toEqual(cameraWhileDocked(layer, home, screen));
  });

  it("follows the camera and the screen size, as the very objects given, once something is docked", () => {
    const layer = itemBoxLayer(busy, filedOf(busy));
    const [vp, size] = cameraWhileDocked(layer, panned, screen);
    expect(vp).toBe(panned);
    expect(size).toBe(screen);
  });
});
