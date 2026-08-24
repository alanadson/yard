/**
 * A fichário (§13) collects several notes into one node with tabs.
 *
 * The decision the whole module rests on: a filed note **stays a note in
 * `items`**. The binder holds ids, not copies. That is not a style choice —
 * `yard note read/write/edit`, the connections drawn to that note, the global
 * search and the locking all address a note by its item, and a binder that
 * swallowed its notes would silently break every one of them. Filing a note is
 * a change of *where it is drawn*, never of what it is.
 *
 * The two invariants that follow, and everything here tests one of them:
 * a note is in at most one binder, and a binder never points at a note that
 * is not there.
 */
import { describe, expect, it } from "vitest";

import {
  activeNoteId,
  binderHolding,
  binderTabs,
  fileIntoBinder,
  filedNoteIds,
  releaseNotes,
  removeFromBinder,
  reorderTab,
} from "./binder";
import { EMPTY_CANVAS, type CanvasData, type CanvasItem } from "./canvas";

function note(id: string, text = id): CanvasItem {
  return { id, type: "note", x: 0, y: 0, w: 200, h: 140, text, color: "#fff" };
}

function binder(id: string, notes: string[], active?: number): CanvasItem {
  return {
    id,
    type: "binder",
    x: 500,
    y: 60,
    w: 320,
    h: 260,
    notes,
    color: "#fff",
    ...(active == null ? {} : { active }),
  };
}

const canvas = (...items: CanvasItem[]): CanvasData => ({ ...EMPTY_CANVAS, items });

describe("filedNoteIds", () => {
  it("lists the notes a binder is showing", () => {
    const c = canvas(note("n1"), note("n2"), binder("b1", ["n1"]));
    expect(filedNoteIds(c.items)).toEqual(new Set(["n1"]));
  });

  it("is empty with no binder on the board", () => {
    expect(filedNoteIds(canvas(note("n1")).items)).toEqual(new Set());
  });
});

describe("binderHolding", () => {
  it("finds the binder a note is filed in", () => {
    const c = canvas(note("n1"), binder("b1", ["n1"]));
    expect(binderHolding(c.items, "n1")?.id).toBe("b1");
  });

  it("gives nothing for a note loose on the board", () => {
    const c = canvas(note("n1"), binder("b1", []));
    expect(binderHolding(c.items, "n1")).toBeUndefined();
  });
});

describe("binderTabs", () => {
  it("keeps the notes in the order the binder lists them", () => {
    const c = canvas(note("n2"), note("n1"), binder("b1", ["n1", "n2"]));
    const tabs = binderTabs(binder("b1", ["n1", "n2"]) as never, c.items);
    expect(tabs.map((t) => t.id)).toEqual(["n1", "n2"]);
  });

  it("skips an id whose note is gone", () => {
    // `yard note delete` can take a filed note out from under the binder.
    // The tab has to vanish with it, not render an empty page.
    const c = canvas(note("n1"), binder("b1", ["n1", "ghost"]));
    const tabs = binderTabs(binder("b1", ["n1", "ghost"]) as never, c.items);
    expect(tabs.map((t) => t.id)).toEqual(["n1"]);
  });
});

describe("activeNoteId", () => {
  const items = canvas(note("n1"), note("n2"), note("n3")).items;

  it("is the tab the binder points at", () => {
    expect(activeNoteId(binder("b1", ["n1", "n2", "n3"], 1) as never, items)).toBe("n2");
  });

  it("falls back to the first tab when the index is past the end", () => {
    // A note removed from the binder leaves `active` pointing at nothing.
    expect(activeNoteId(binder("b1", ["n1"], 4) as never, items)).toBe("n1");
  });

  it("is null for an empty binder", () => {
    expect(activeNoteId(binder("b1", []) as never, items)).toBeNull();
  });
});

describe("fileIntoBinder", () => {
  it("adds the note to the binder's tabs", () => {
    const c = canvas(note("n1"), binder("b1", []));
    const out = fileIntoBinder(c, "b1", "n1");
    expect((out.items[1] as { notes: string[] }).notes).toEqual(["n1"]);
  });

  it("shows the note it just filed", () => {
    // Filing something and not seeing it is the surest way to think it was
    // lost. The new tab is the one on screen.
    const c = canvas(note("n1"), note("n2"), binder("b1", ["n1"]));
    const out = fileIntoBinder(c, "b1", "n2");
    const b = out.items.find((i) => i.id === "b1") as { active?: number };
    expect(b.active).toBe(1);
  });

  it("takes the note out of the binder that had it", () => {
    // The invariant: one note, one binder. Two binders drawing the same note
    // would fight over its edits and its wires.
    const c = canvas(note("n1"), binder("b1", ["n1"]), binder("b2", []));
    const out = fileIntoBinder(c, "b2", "n1");
    expect((out.items.find((i) => i.id === "b1") as { notes: string[] }).notes).toEqual([]);
    expect((out.items.find((i) => i.id === "b2") as { notes: string[] }).notes).toEqual([
      "n1",
    ]);
  });

  it("refuses to file a binder into itself", () => {
    const c = canvas(binder("b1", []));
    expect(fileIntoBinder(c, "b1", "b1")).toBe(c);
  });

  it("refuses anything that is not a note", () => {
    // A portal has a live browser glued to its rectangle and a terminal is a
    // process; neither survives being drawn inside a tab strip.
    const portal: CanvasItem = {
      id: "p1",
      type: "portal",
      x: 0,
      y: 0,
      w: 320,
      h: 240,
      url: "http://localhost",
      color: "#fff",
    };
    const c = canvas(portal, binder("b1", []));
    expect(fileIntoBinder(c, "b1", "p1")).toBe(c);
  });
});

describe("removeFromBinder", () => {
  it("drops the tab and leaves the note on the board", () => {
    const c = canvas(note("n1"), note("n2"), binder("b1", ["n1", "n2"]));
    const out = removeFromBinder(c, "n1");
    expect((out.items.find((i) => i.id === "b1") as { notes: string[] }).notes).toEqual([
      "n2",
    ]);
    expect(out.items.some((i) => i.id === "n1")).toBe(true);
  });

  it("puts the freed note where it can be seen, not under the binder", () => {
    // It had no meaningful position while it was filed; dropping it at its
    // stale coordinates would hide it behind whatever is there now.
    const c = canvas(note("n1"), binder("b1", ["n1"]));
    const out = removeFromBinder(c, "n1");
    const freed = out.items.find((i) => i.id === "n1") as { x: number; y: number };
    expect(freed.x).toBeGreaterThanOrEqual(500);
  });
});

describe("releaseNotes", () => {
  it("frees every note when the binder itself goes", () => {
    // Deleting a fichário must never be a way to lose the notes inside it.
    const c = canvas(note("n1"), note("n2"), binder("b1", ["n1", "n2"]));
    const out = releaseNotes(c, "b1");
    expect(out.items.filter((i) => i.type === "note")).toHaveLength(2);
  });

  it("spreads them out instead of stacking them on one spot", () => {
    const c = canvas(note("n1"), note("n2"), binder("b1", ["n1", "n2"]));
    const out = releaseNotes(c, "b1");
    const [a, b] = out.items.filter((i) => i.type === "note") as { x: number }[];
    expect(a.x).not.toBe(b.x);
  });
});

describe("reorderTab", () => {
  it("moves a tab to another position", () => {
    const c = canvas(note("n1"), note("n2"), note("n3"), binder("b1", ["n1", "n2", "n3"]));
    const out = reorderTab(c, "b1", 2, 0);
    expect((out.items.find((i) => i.id === "b1") as { notes: string[] }).notes).toEqual([
      "n3",
      "n1",
      "n2",
    ]);
  });

  it("keeps the same note showing after the move", () => {
    // Reordering is arranging, not navigating: the page under your eyes must
    // not change because you dragged a tab somewhere else.
    const c = canvas(note("n1"), note("n2"), binder("b1", ["n1", "n2"], 0));
    const out = reorderTab(c, "b1", 0, 1);
    const b = out.items.find((i) => i.id === "b1") as { notes: string[]; active?: number };
    expect(b.notes[b.active ?? 0]).toBe("n1");
  });
});
