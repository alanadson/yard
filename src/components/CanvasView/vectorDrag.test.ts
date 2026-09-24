/**
 * Dragging a stroke moves one or a few items, but the vector layer used to
 * rebuild the element of every item on the board on every frame of the
 * gesture. The rule here is what the layer paints from: which offset each
 * item gets from the live drag, and a list in which only the dragged entries
 * are new while every other one is the very same value it was.
 */
import { describe, expect, it } from "vitest";

import { dragShift, withDragged } from "./vectorDrag";

const drag = (ids: string[], dx: number, dy: number) => ({ ids: new Set(ids), dx, dy });

describe("dragShift", () => {
  it("gives a member of the gesture the gesture's offset", () => {
    expect(dragShift(drag(["a", "b"], 12, -4), "b")).toEqual({ dx: 12, dy: -4 });
  });

  it("leaves an item outside the gesture where it rests", () => {
    expect(dragShift(drag(["a"], 12, -4), "z")).toEqual({ dx: 0, dy: 0 });
  });

  it("leaves everything where it rests when nothing is being dragged", () => {
    expect(dragShift(null, "a")).toEqual({ dx: 0, dy: 0 });
  });
});

describe("withDragged", () => {
  const items = [{ id: "a" }, { id: "n" }, { id: "b" }, { id: "c" }];
  /** One painted entry per item; `null` is an item another layer draws. */
  const base = () => [{ el: "a" }, null, { el: "b" }, { el: "c" }];

  it("returns the base list itself when nothing is being dragged", () => {
    const b = base();
    expect(withDragged(b, items, null, () => ({ el: "moved" }))).toBe(b);
  });

  it("rebuilds only the dragged entries and keeps every other one as it was", () => {
    const b = base();
    const out = withDragged(b, items, drag(["b"], 5, 5), (i) => ({ el: `moved ${items[i].id}` }));
    expect(out).not.toBe(b);
    expect(out[2]).toEqual({ el: "moved b" });
    expect(out[0]).toBe(b[0]);
    expect(out[3]).toBe(b[3]);
  });

  it("does not paint here an item another layer draws, even when it is dragged", () => {
    const b = base();
    const out = withDragged(b, items, drag(["n", "c"], 5, 5), (i) => ({ el: `moved ${items[i].id}` }));
    expect(out[1]).toBeNull();
    expect(out[3]).toEqual({ el: "moved c" });
  });

  it("returns the base list itself when the gesture holds nothing this layer paints", () => {
    const b = base();
    expect(withDragged(b, items, drag(["n", "elsewhere"], 5, 5), () => ({ el: "moved" }))).toBe(b);
  });
});
