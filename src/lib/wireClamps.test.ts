/** Cable clamps change routing only; they never widen the agent connection graph. */
import { expect, it } from "vitest";
import {
  EMPTY_CANVAS,
  normalizeCanvas,
  reconcileItems,
  type CanvasItem,
} from "./canvas";
import { bundleWires, positionClamp, copyWireRouting } from "./wireClamps";

it("gives copied cables an independent clamp at their translated location", () => {
  const wires: CanvasItem[] = ["b", "c"].map((to) => ({
    id: to,
    type: "connection",
    from: "a",
    to,
    color: "#fff",
    clamp: { id: "original", x: 100, y: 200 },
  }));
  const copies = copyWireRouting(wires, 24, 48, () => "copy");
  expect(copies).toEqual(
    wires.map((wire) => ({ ...wire, clamp: { id: "copy", x: 124, y: 248 } })),
  );
  expect(
    positionClamp([...wires, ...copies], "copy", { x: 500, y: 600 }).slice(
      0,
      2,
    ),
  ).toEqual(wires);
});

it("drops corrupt clamp coordinates without losing the connection", () => {
  const wire = {
    id: "wire",
    type: "connection",
    from: "a",
    to: "b",
    color: "#fff",
  };
  const restored = normalizeCanvas({
    ...EMPTY_CANVAS,
    items: [{ ...wire, clamp: { id: "broken", x: "bad", y: 20 } }],
  })!;
  expect(restored.items).toEqual([wire]);
});

it("moves and releases a shared clamp without disconnecting its cables", () => {
  const wires: CanvasItem[] = ["b", "c"].map((to) => ({
    id: to,
    type: "connection",
    from: "a",
    to,
    color: "#fff",
    clamp: { id: "shared", x: 100, y: 200 },
  }));
  const moved = positionClamp(wires, "shared", { x: 300, y: 400 });
  expect(
    moved.map((item) => (item.type === "connection" ? item.clamp : null)),
  ).toEqual([
    { id: "shared", x: 300, y: 400 },
    { id: "shared", x: 300, y: 400 },
  ]);
  const released = positionClamp(moved, "shared", undefined);
  expect(released).toEqual(
    wires.map((item) => {
      const { clamp: _old, ...rest } = item as Extract<
        CanvasItem,
        { type: "connection" }
      >;
      return rest;
    }),
  );
});

it("bundles selected cables without changing their endpoints or other cables", () => {
  const wires: CanvasItem[] = [
    { id: "one", type: "connection", from: "a", to: "b", color: "#fff" },
    { id: "two", type: "connection", from: "a", to: "c", color: "#fff" },
    { id: "three", type: "connection", from: "b", to: "c", color: "#fff" },
  ];
  const changed = bundleWires(wires, new Set(["one", "two"]), {
    id: "clamp",
    x: 200,
    y: 300,
  });
  const saved = normalizeCanvas({
    ...EMPTY_CANVAS,
    nodes: {
      a: { x: 0, y: 0, w: 100, h: 100 },
      b: { x: 400, y: 0, w: 100, h: 100 },
      c: { x: 400, y: 300, w: 100, h: 100 },
    },
    items: changed,
  })!;
  const restored = reconcileItems(wires, saved.items);
  expect(restored[0]).toMatchObject({
    ...wires[0],
    clamp: { id: "clamp", x: 200, y: 300 },
  });
  expect(restored[1]).toMatchObject({
    ...wires[1],
    clamp: { id: "clamp", x: 200, y: 300 },
  });
  expect(restored[2]).toEqual(wires[2]);
});
