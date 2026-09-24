/**
 * What the pane grid subscribes to, and why it is so little.
 *
 * The grid used to subscribe to the whole `groups` array and the whole
 * `terminals` array just to read its own group's layout and CLIs. Every write
 * to any group (a board's viewport commit, an agent writing to a board note
 * through `yard`, a tab switch on another floor) re-rendered every pane of
 * the group on screen, and every xterm inside them. Nothing on screen showed
 * it; only the profiler did. These rules lock the narrow answers: equal while
 * another group is written, new the moment this group's own data changes.
 */
import { describe, expect, it } from "vitest";

import type { GroupRow, TerminalRow } from "../../lib/ipc";
import { groupTerminalsSelector, layoutJsonOf } from "./selectors";

function group(id: string, layout: object, projectId: string | null = "p"): GroupRow {
  return { id, projectId, name: id, layoutJson: JSON.stringify(layout), suspended: false, sort: 0 };
}

function terminal(id: string, groupId: string, over: Partial<TerminalRow> = {}): TerminalRow {
  return {
    id,
    groupId,
    slot: 0,
    surface: "grid",
    sort: 0,
    kind: "shell",
    program: "pwsh",
    args: [],
    cwd: "C:/p",
    title: "",
    alive: false,
    createdAt: 0,
    ...over,
  };
}

/** The shape every store write has: the one row replaced, the others kept. */
function rewrite<T extends { id: string }>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

describe("layoutJsonOf: the grid reads its own group's layout and nothing else", () => {
  it("stays equal when another group's layout is rewritten (a board's viewport commit)", () => {
    const groups = [group("mine", { mode: "auto" }), group("board", { canvas: { viewport: { x: 0 } } }, null)];
    const before = layoutJsonOf(groups, "mine");
    const after = layoutJsonOf(
      rewrite(groups, "board", { layoutJson: JSON.stringify({ canvas: { viewport: { x: 40 } } }) }),
      "mine",
    );
    expect(after).toBe(before);
  });

  it("changes when this group's own layout is written (a tab switch here)", () => {
    const groups = [group("mine", { activeBySlot: { 0: "a" } })];
    const before = layoutJsonOf(groups, "mine");
    const after = layoutJsonOf(
      rewrite(groups, "mine", { layoutJson: JSON.stringify({ activeBySlot: { 0: "b" } }) }),
      "mine",
    );
    expect(after).not.toBe(before);
    expect(after).toBe(JSON.stringify({ activeBySlot: { 0: "b" } }));
  });

  it("reads a group that is not there as the empty layout, the default the parser fills in", () => {
    expect(layoutJsonOf([group("other", {})], "gone")).toBe("");
  });
});

describe("groupTerminalsSelector: the group's CLIs, stable while nothing of theirs changes", () => {
  it("hands back the same array when a terminal of another group is rewritten", () => {
    const rows = [terminal("a", "mine"), terminal("x", "other")];
    const select = groupTerminalsSelector("mine");
    const before = select({ terminals: rows });
    const after = select({ terminals: rewrite(rows, "x", { title: "renamed elsewhere" }) });
    expect(after).toBe(before);
    expect(after.map((t) => t.id)).toEqual(["a"]);
  });

  it("hands out a new array when one of its own CLIs is rewritten", () => {
    const rows = [terminal("a", "mine"), terminal("x", "other")];
    const select = groupTerminalsSelector("mine");
    const before = select({ terminals: rows });
    const after = select({ terminals: rewrite(rows, "a", { title: "renamed here" }) });
    expect(after).not.toBe(before);
    expect(after[0].title).toBe("renamed here");
  });

  it("hands out a new array when a CLI moves into the group or leaves it", () => {
    const rows = [terminal("a", "mine"), terminal("x", "other")];
    const select = groupTerminalsSelector("mine");
    select({ terminals: rows });
    const joined = select({ terminals: rewrite(rows, "x", { groupId: "mine" }) });
    expect(joined.map((t) => t.id)).toEqual(["a", "x"]);
    const left = select({ terminals: rewrite(rows, "a", { groupId: "other" }) });
    expect(left).toEqual([]);
  });

  it("keeps the store's order, the one the tab bar and the slots are built from", () => {
    const rows = [terminal("b", "mine"), terminal("x", "other"), terminal("a", "mine")];
    expect(groupTerminalsSelector("mine")({ terminals: rows }).map((t) => t.id)).toEqual(["b", "a"]);
  });
});
