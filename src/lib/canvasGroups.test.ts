/**
 * A frame ("grupo") is organizational: it names a region of the board and
 * carries whatever stands inside it, and that is the whole of it. §5.4 of the
 * spec is explicit that it must not get in the way of selecting or wiring the
 * elements it holds — so membership can never be a stored list of ids that a
 * delete, a paste or an agent's `yard` call could leave pointing at nothing.
 *
 * Membership is therefore **geometric**: a thing is in the frame when its box
 * is inside the frame's box. These tests lock that down, and with it the two
 * rules that fall out of it — dragging the frame drags what it holds, and the
 * frame around a selection is the union of that selection plus air.
 */
import { describe, expect, it } from "vitest";

import {
  GROUP_HEAD,
  GROUP_PAD,
  addFrame,
  frameAround,
  frameItem,
  membersOf,
  withGroupMembers,
} from "./canvasGroups";
import { removeItemAndEdges } from "./canvasOps";
import { EMPTY_CANVAS, type Box, type CanvasItem } from "./canvas";

const frame: Box = { x: 0, y: 0, w: 400, h: 300 };

describe("membersOf", () => {
  it("holds a box that sits entirely inside the frame", () => {
    const boxes = { card: { x: 50, y: 60, w: 100, h: 80 } };
    expect(membersOf(frame, boxes)).toEqual(["card"]);
  });

  it("does not hold a box that straddles the frame's edge", () => {
    // Half in, half out: the user parked it on the border, and counting it
    // would make dragging the frame yank a card that visibly is not in it.
    const boxes = { card: { x: 350, y: 60, w: 100, h: 80 } };
    expect(membersOf(frame, boxes)).toEqual([]);
  });

  it("does not hold a box that merely overlaps from outside", () => {
    const boxes = { card: { x: -50, y: -50, w: 600, h: 500 } };
    expect(membersOf(frame, boxes)).toEqual([]);
  });

  it("never holds itself", () => {
    // The frame's own box is trivially inside its own box. Without this the
    // first drag would add the frame to its own moving set twice and move it
    // by double the delta.
    const boxes = { g1: frame, card: { x: 10, y: 10, w: 20, h: 20 } };
    expect(membersOf(frame, boxes, "g1")).toEqual(["card"]);
  });

  it("holds a smaller frame nested inside it", () => {
    // Nesting is what makes "Frontend Team" inside "Squad" work, and it comes
    // free from containment — there is no parent pointer to keep honest.
    const boxes = { inner: { x: 20, y: 20, w: 100, h: 100 } };
    expect(membersOf(frame, boxes, "outer")).toEqual(["inner"]);
  });
});

describe("withGroupMembers", () => {
  const boxes = {
    g1: frame,
    card: { x: 50, y: 60, w: 100, h: 80 },
    note: { x: 20, y: 200, w: 60, h: 40 },
    away: { x: 900, y: 900, w: 50, h: 50 },
  };
  const groups = [{ id: "g1", box: frame }];

  it("drags what the grabbed frame holds", () => {
    expect(withGroupMembers(new Set(["g1"]), groups, boxes)).toEqual(
      new Set(["g1", "card", "note"]),
    );
  });

  it("leaves what is outside the frame alone", () => {
    const out = withGroupMembers(new Set(["g1"]), groups, boxes);
    expect(out.has("away")).toBe(false);
  });

  it("gives back the same set when no frame was grabbed", () => {
    expect(withGroupMembers(new Set(["card"]), groups, boxes)).toEqual(new Set(["card"]));
  });

  it("expands a frame reached through another frame", () => {
    // Outer holds inner; grabbing outer has to carry inner's contents too,
    // even though `card` is only *directly* listed as inner's member here.
    const outer: Box = { x: 0, y: 0, w: 400, h: 300 };
    const inner: Box = { x: 10, y: 10, w: 200, h: 200 };
    const nested = {
      outer,
      inner,
      card: { x: 20, y: 20, w: 50, h: 50 },
    };
    const gs = [
      { id: "outer", box: outer },
      { id: "inner", box: inner },
    ];
    expect(withGroupMembers(new Set(["outer"]), gs, nested)).toEqual(
      new Set(["outer", "inner", "card"]),
    );
  });
});

describe("frameAround", () => {
  it("wraps the selection with air on every side", () => {
    const box = frameAround([{ x: 100, y: 100, w: 200, h: 100 }]);
    expect(box).toEqual({
      x: 100 - GROUP_PAD,
      y: 100 - GROUP_PAD - GROUP_HEAD,
      w: 200 + GROUP_PAD * 2,
      h: 100 + GROUP_PAD * 2 + GROUP_HEAD,
    });
  });

  it("reserves the title band above the content, not over it", () => {
    // The band is where the name is drawn and where the frame is grabbed. If
    // it overlapped the first card, grabbing the frame by its title would
    // start a drag on the card instead.
    const content = { x: 0, y: 0, w: 100, h: 100 };
    const box = frameAround([content])!;
    expect(content.y - box.y).toBeGreaterThanOrEqual(GROUP_HEAD);
  });

  it("refuses to wrap nothing", () => {
    expect(frameAround([])).toBeNull();
  });
});

describe("addFrame", () => {
  const note: CanvasItem = {
    id: "n1",
    type: "note",
    x: 10,
    y: 10,
    w: 100,
    h: 80,
    text: "spec",
    color: "#fff",
  };

  it("puts the frame behind everything already on the board", () => {
    // Paint order is array order. A frame appended last would sit on top of
    // the very cards it wraps, and its border would cut across them.
    const c = { ...EMPTY_CANVAS, items: [note] };
    const out = addFrame(c, frameItem("g1", frame, "Frontend"));
    expect(out.items.map((i) => i.id)).toEqual(["g1", "n1"]);
  });

  it("keeps the members on the board when the frame is removed", () => {
    // Ungroup is exactly this: the frame goes, what it held stays. §5.4 calls
    // the group organizational — deleting it must never be a way to lose work.
    const c = addFrame({ ...EMPTY_CANVAS, items: [note] }, frameItem("g1", frame, "F"));
    const out = removeItemAndEdges(c, "g1");
    expect(out.items).toEqual([note]);
  });
});

describe("frameItem", () => {
  it("names the frame what it was told", () => {
    expect(frameItem("g1", frame, "Frontend")).toMatchObject({
      id: "g1",
      type: "group",
      name: "Frontend",
    });
  });
});
