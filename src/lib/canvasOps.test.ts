/**
 * The canvas graph transformations. The one that matters is
 * `removeItemAndEdges`: a wire left pointing at a deleted note is persisted,
 * survives a reload and keeps `connectedNotes` walking through it — the bug
 * these helpers exist to make impossible to reintroduce.
 */
import { describe, expect, it } from "vitest";

import {
  addItems,
  connection,
  isConnected,
  patchItem,
  patchItemOfType,
  removeItemAndEdges,
  removeNodeAndEdges,
  reorderItem,
  setEntry,
} from "./canvasOps";
import { EMPTY_CANVAS, type CanvasData, type CanvasItem } from "./canvas";

function note(id: string, text = ""): CanvasItem {
  return { id, type: "note", x: 0, y: 0, w: 100, h: 100, text, color: "#fff" };
}

function canvas(items: CanvasItem[] = [], nodes = {}): CanvasData {
  return { ...EMPTY_CANVAS, viewport: { ...EMPTY_CANVAS.viewport }, items, nodes };
}

describe("addItems / connection", () => {
  it("appends in order and does not touch the rest", () => {
    const c = canvas([note("a")]);
    const next = addItems(c, note("b"), note("c"));
    expect(next.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(next.items[0]).toBe(c.items[0]);
  });

  it("connection() carries both endpoints and a fresh id", () => {
    const wire = connection("a", "b");
    expect(wire.type).toBe("connection");
    if (wire.type !== "connection") throw new Error("tipo errado");
    expect(wire.from).toBe("a");
    expect(wire.to).toBe("b");
    expect(connection("a", "b").id).not.toBe(wire.id);
  });
});

describe("isConnected", () => {
  it("ignores direction", () => {
    const c = canvas([connection("a", "b")]);
    expect(isConnected(c, "a", "b")).toBe(true);
    expect(isConnected(c, "b", "a")).toBe(true);
    expect(isConnected(c, "a", "c")).toBe(false);
  });
});

describe("patchItem", () => {
  it("replaces only the target", () => {
    const c = canvas([note("a", "um"), note("b", "dois")]);
    const next = patchItem(c, "b", (i) =>
      i.type === "note" ? { ...i, text: "novo" } : i,
    );
    expect(next.items[0]).toBe(c.items[0]);
    expect((next.items[1] as { text: string }).text).toBe("novo");
  });

  it("patchItemOfType leaves items of another type alone", () => {
    const c = canvas([note("a", "um")]);
    const next = patchItemOfType(c, "a", "portal", { url: "x" });
    expect(next.items[0]).toBe(c.items[0]);
  });
});

describe("removeItemAndEdges", () => {
  it("drops the item and every wire that referenced it", () => {
    const c = canvas([
      note("a"),
      note("b"),
      connection("a", "b"),
      connection("b", "a"),
      connection("b", "c"),
    ]);
    const next = removeItemAndEdges(c, "a");
    expect(next.items.map((i) => i.id)).toHaveLength(2);
    expect(next.items.some((i) => i.id === "a")).toBe(false);
    // Only the wire that never touched "a" survives.
    const wires = next.items.filter((i) => i.type === "connection");
    expect(wires).toHaveLength(1);
    expect(wires[0].type === "connection" && wires[0].to).toBe("c");
  });
});

describe("removeNodeAndEdges", () => {
  it("clears rectangle, role, routines and wires of a terminal", () => {
    const c: CanvasData = {
      ...canvas([connection("t1", "n1"), note("n1")], {
        t1: { x: 0, y: 0, w: 10, h: 10 },
        t2: { x: 1, y: 1, w: 10, h: 10 },
      }),
      roles: { t1: "revisora", t2: "outra" },
      routines: [
        { id: "r1", terminalId: "t1", text: "x", everyMin: 5, enabled: true, createdAt: 0 },
        { id: "r2", terminalId: "t2", text: "y", everyMin: 5, enabled: true, createdAt: 0 },
      ],
    };
    const next = removeNodeAndEdges(c, "t1");
    expect(Object.keys(next.nodes)).toEqual(["t2"]);
    expect(next.roles).toEqual({ t2: "outra" });
    expect(next.routines?.map((r) => r.id)).toEqual(["r2"]);
    expect(next.items.map((i) => i.id)).toEqual(["n1"]);
  });

  it("drops the roles map entirely when it empties", () => {
    const c: CanvasData = { ...canvas(), roles: { t1: "só essa" } };
    expect(removeNodeAndEdges(c, "t1").roles).toBeUndefined();
  });
});

describe("reorderItem", () => {
  it("moves to front and to back", () => {
    const c = canvas([note("a"), note("b"), note("c")]);
    expect(reorderItem(c, "a", "front").items.map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(reorderItem(c, "c", "back").items.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op for an unknown id", () => {
    const c = canvas([note("a")]);
    expect(reorderItem(c, "zzz", "front")).toBe(c);
  });
});

describe("setEntry", () => {
  it("sets, trims, deletes and collapses to undefined", () => {
    expect(setEntry(undefined, "a", "  x  ")).toEqual({ a: "x" });
    expect(setEntry({ a: "x", b: "y" }, "a", undefined)).toEqual({ b: "y" });
    expect(setEntry({ a: "x" }, "a", "   ")).toBeUndefined();
    expect(setEntry({ a: "x" }, "a", undefined)).toBeUndefined();
  });
});
