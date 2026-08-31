/**
 * What a pane's tab bar shows, in order.
 *
 * Two things read this order and must never disagree: the bar `TerminalPane`
 * paints, and the keyboard (Ctrl+Tab, Ctrl+1..9). While only files could be
 * pinned that was easy to get away with — the keyboard walked the store's
 * order and the eye saw the bar's, and the two only differed when a file was
 * pinned. Now every kind of tab can be pinned, so the divergence would be the
 * common case: one function, tested here, is what both of them call.
 *
 * Since the bar accepts a drop anywhere, the sections (CLIs, then files, then
 * pages) are only the *default* order: a CLI can sit between two files. What
 * the user arranged by hand is a plain list of ids saved with the group's
 * layout, and it is what these tests are mostly about — the sections survive
 * as the answer for a pane nobody has ever rearranged.
 */
import { describe, expect, it } from "vitest";

import { barOrder, placeInBar, stepInBar, type BarInput, type TabRef } from "./paneBar";

const input = (over: Partial<BarInput> = {}): BarInput => ({
  groupId: "g1",
  slot: 0,
  terminals: [],
  docs: [],
  browsers: [],
  notesId: null,
  ...over,
});

const at = (id: string, pinned = false) => ({ id, groupId: "g1", slot: 0, pinned });

/** A bar as `barOrder` hands it over, written short. */
const bar = (...tabs: [string, TabRef["kind"], boolean?][]): TabRef[] =>
  tabs.map(([id, kind, pinned]) => ({ id, kind, pinned: pinned === true }));

describe("barOrder", () => {
  it("paints the four kinds in the order the pane draws them", () => {
    const order = barOrder(
      input({
        terminals: [at("cli")],
        docs: [at("file")],
        browsers: [at("page")],
        notesId: "notes",
      }),
    );

    expect(order.map((t) => [t.id, t.kind])).toEqual([
      ["cli", "terminal"],
      ["file", "doc"],
      ["page", "browser"],
      ["notes", "notes"],
    ]);
  });

  it("a saved order puts a CLI between two files", () => {
    // The whole point of the change: the sections are a default, not a wall.
    const order = barOrder(
      input({
        terminals: [at("cli")],
        docs: [at("compose"), at("agents")],
        order: ["compose", "cli", "agents"],
      }),
    );

    expect(order.map((t) => t.id)).toEqual(["compose", "cli", "agents"]);
  });

  it("a tab the saved order never heard of goes to the end of the bar", () => {
    // A file opened after the user arranged the bar: it lands at the end,
    // where a new tab belongs, instead of jumping into the middle because
    // its kind's section happens to sit there.
    const order = barOrder(
      input({
        terminals: [at("cli")],
        docs: [at("compose"), at("fresh")],
        order: ["compose", "cli"],
      }),
    );

    expect(order.map((t) => t.id)).toEqual(["compose", "cli", "fresh"]);
  });

  it("ignores an id the saved order names but the pane no longer holds", () => {
    const order = barOrder(
      input({ docs: [at("compose")], order: ["gone", "compose"] }),
    );

    expect(order.map((t) => t.id)).toEqual(["compose"]);
  });

  it("puts the pinned tabs at the front of the whole bar", () => {
    // The contract that changed with the free order: a pin used to hold the
    // front of its own section, which only meant anything while the sections
    // were the bar's shape. With a CLI able to sit between two files there is
    // no section to be at the front of — a pin holds the front of the bar.
    const order = barOrder(
      input({
        terminals: [at("cli1"), at("cli2", true)],
        docs: [at("file1"), at("file2", true)],
        browsers: [at("page1")],
      }),
    );

    expect(order.map((t) => t.id)).toEqual([
      "cli2",
      "file2",
      "cli1",
      "file1",
      "page1",
    ]);
  });

  it("keeps the saved order inside each half of the pin line", () => {
    const order = barOrder(
      input({
        terminals: [at("cli", true)],
        docs: [at("compose"), at("agents", true)],
        order: ["compose", "agents", "cli"],
      }),
    );

    expect(order.map((t) => t.id)).toEqual(["agents", "cli", "compose"]);
  });

  it("leaves out what belongs to another pane", () => {
    const order = barOrder(
      input({
        terminals: [at("here"), { ...at("elsewhere"), slot: 1 }],
        docs: [{ ...at("other-group"), groupId: "g2" }],
      }),
    );

    expect(order.map((t) => t.id)).toEqual(["here"]);
  });

  it("an empty pane has no tabs at all", () => {
    expect(barOrder(input())).toEqual([]);
  });
});

describe("placeInBar", () => {
  it("drops the tab right in front of the one it was let go on", () => {
    const next = placeInBar(
      bar(["cli", "terminal"], ["compose", "doc"], ["agents", "doc"]),
      { id: "cli", kind: "terminal", pinned: false },
      "agents",
    );

    expect(next.map((t) => t.id)).toEqual(["compose", "cli", "agents"]);
  });

  it("no target means the end of the bar", () => {
    const next = placeInBar(
      bar(["cli", "terminal"], ["compose", "doc"]),
      { id: "cli", kind: "terminal", pinned: false },
      null,
    );

    expect(next.map((t) => t.id)).toEqual(["compose", "cli"]);
  });

  it("a tab arriving from another pane joins the bar it was dropped on", () => {
    const next = placeInBar(
      bar(["compose", "doc"], ["agents", "doc"]),
      { id: "page", kind: "browser", pinned: false },
      "agents",
    );

    expect(next.map((t) => t.id)).toEqual(["compose", "page", "agents"]);
  });

  it("a loose tab dropped among the pinned ones stops at the pin line", () => {
    // Not a refusal: the drop lands, at the first place the bar can hold it.
    // Anything else would be undone by the next render, and a drag that
    // silently springs back reads as a broken drag.
    const next = placeInBar(
      bar(["cli", "terminal", true], ["compose", "doc", true], ["agents", "doc"]),
      { id: "agents", kind: "doc", pinned: false },
      "compose",
    );

    expect(next.map((t) => t.id)).toEqual(["cli", "compose", "agents"]);
  });

  it("does not leave the tab in the bar twice when it only moved", () => {
    const next = placeInBar(
      bar(["a", "doc"], ["b", "doc"], ["c", "doc"]),
      { id: "c", kind: "doc", pinned: false },
      "a",
    );

    expect(next.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
});

describe("stepInBar", () => {
  it("one step left takes the neighbour's place, whatever kind it is", () => {
    const step = stepInBar(
      bar(["compose", "doc"], ["cli", "terminal"]),
      "cli",
      -1,
    );

    expect(step).toEqual({ beforeId: "compose" });
  });

  it("one step right has to clear the neighbour first", () => {
    const step = stepInBar(
      bar(["cli", "terminal"], ["compose", "doc"], ["agents", "doc"]),
      "cli",
      1,
    );

    expect(step).toEqual({ beforeId: "agents" });
  });

  it("the last step right is the end of the bar", () => {
    const step = stepInBar(bar(["cli", "terminal"], ["compose", "doc"]), "cli", 1);

    expect(step).toEqual({ beforeId: null });
  });

  it("the ends of the bar are walls", () => {
    const one = bar(["cli", "terminal"], ["compose", "doc"]);

    expect(stepInBar(one, "cli", -1)).toBeNull();
    expect(stepInBar(one, "compose", 1)).toBeNull();
  });

  it("the pin line is a wall too", () => {
    const mixed = bar(["cli", "terminal", true], ["compose", "doc"]);

    expect(stepInBar(mixed, "compose", -1)).toBeNull();
    expect(stepInBar(mixed, "cli", 1)).toBeNull();
  });

  it("a tab that is not in this bar goes nowhere", () => {
    expect(stepInBar(bar(["cli", "terminal"]), "ghost", 1)).toBeNull();
  });
});
