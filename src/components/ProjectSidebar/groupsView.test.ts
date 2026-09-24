/**
 * The sidebar paints every group of the workspace, but only four things about
 * each: its id, its project, its name and its place (`sort`), plus the floor
 * of a project's group (which branch, which worktree). Everything else a
 * group carries lives in `layoutJson` and changes all the time: the canvas
 * on every keystroke in a board note, the viewport on every pan, the active
 * tab on every click. Subscribed to the raw `groups` array, the whole tree
 * (hundreds of rows) reconciled on each of those writes. These rules lock
 * both halves of the narrower subscription: the same array while only
 * unpainted data moved, a new one the moment a painted field changes.
 */
import { describe, expect, it } from "vitest";

import type { GroupRow } from "../../lib/ipc";
import { parseLayout } from "../../stores/projectsStore";
import { sameSidebarGroups, sidebarGroupsSelector } from "./groupsView";

function group(id: string, over: Partial<GroupRow> = {}, layout: object = {}): GroupRow {
  return {
    id,
    projectId: "p1",
    name: id,
    layoutJson: JSON.stringify(layout),
    suspended: false,
    sort: 0,
    ...over,
  };
}

/** The shape every store write has: the one row replaced, the others kept. */
function rewrite(rows: GroupRow[], id: string, patch: Partial<GroupRow>): GroupRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

const floorOf = (g: GroupRow) => parseLayout(g.layoutJson).floor;

describe("sidebar groups: kept while only unpainted data moves", () => {
  it("keeps the array when a board's canvas is rewritten (a keystroke in a note)", () => {
    const rows = [group("ground"), group("board", { projectId: null }, { canvas: { items: [] } })];
    const select = sidebarGroupsSelector();
    const before = select({ groups: rows });
    const after = select({
      groups: rewrite(rows, "board", {
        layoutJson: JSON.stringify({ canvas: { items: [{ id: "n1", text: "a" }] } }),
      }),
    });
    expect(after).toBe(before);
  });

  it("keeps the array when a project group's tab, viewport or pane mode changes", () => {
    const floor = { kind: "isolated", branch: "feat", worktreePath: "C:/w/feat" };
    const rows = [group("front", {}, { floor, activeBySlot: { 0: "a" } })];
    const select = sidebarGroupsSelector();
    const before = select({ groups: rows });
    const after = select({
      groups: rewrite(rows, "front", {
        layoutJson: JSON.stringify({ floor, activeBySlot: { 0: "b" }, mode: "grid", panelCount: 4 }),
      }),
    });
    expect(after).toBe(before);
  });

  it("keeps the array when a group is suspended or resumed, which the tree does not paint", () => {
    const rows = [group("ground")];
    const select = sidebarGroupsSelector();
    const before = select({ groups: rows });
    expect(select({ groups: rewrite(rows, "ground", { suspended: true }) })).toBe(before);
  });

  it("a kept row still paints what the new one would: same floor, same name, same place", () => {
    const floor = { kind: "isolated", branch: "feat", worktreePath: "C:/w/feat" };
    const old = group("front", { name: "Feat", sort: 3 }, { floor, activeBySlot: { 0: "a" } });
    const next = { ...old, layoutJson: JSON.stringify({ floor, activeBySlot: { 0: "b" } }) };
    expect(sameSidebarGroups([old], [next])).toBe(true);
    expect(floorOf(old)).toEqual(floorOf(next));
    expect([old.id, old.projectId, old.name, old.sort]).toEqual([
      next.id,
      next.projectId,
      next.name,
      next.sort,
    ]);
  });
});

describe("sidebar groups: a new array the moment a painted field changes", () => {
  it("on a rename", () => {
    const rows = [group("ground")];
    const select = sidebarGroupsSelector();
    const before = select({ groups: rows });
    const after = select({ groups: rewrite(rows, "ground", { name: "Principal" }) });
    expect(after).not.toBe(before);
    expect(after[0].name).toBe("Principal");
  });

  it("on a move (the sort key) and on a group changing project", () => {
    const rows = [group("a"), group("b", { sort: 1 })];
    expect(sameSidebarGroups(rows, rewrite(rows, "b", { sort: -1 }))).toBe(false);
    expect(sameSidebarGroups(rows, rewrite(rows, "b", { projectId: "p2" }))).toBe(false);
  });

  it("when a group is added, removed or the list is reordered", () => {
    const rows = [group("a"), group("b")];
    expect(sameSidebarGroups(rows, [...rows, group("c")])).toBe(false);
    expect(sameSidebarGroups(rows, rows.slice(1))).toBe(false);
    expect(sameSidebarGroups(rows, [rows[1], rows[0]])).toBe(false);
  });

  it("when a project group's floor changes: the branch chip and the label read it", () => {
    const rows = [group("front", {}, { floor: { kind: "isolated", branch: "feat" } })];
    expect(
      sameSidebarGroups(
        rows,
        rewrite(rows, "front", {
          layoutJson: JSON.stringify({ floor: { kind: "isolated", branch: "feat-2" } }),
        }),
      ),
    ).toBe(false);
  });
});
