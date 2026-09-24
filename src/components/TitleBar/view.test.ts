/**
 * What the title bar reads from the workspace, and nothing more.
 *
 * The bar paints a breadcrumb (project, group, floor branch) and the pane
 * switch (mode and pane count of the group that owns the panes). It used to
 * subscribe to the whole `groups` array for that, so every canvas keystroke,
 * viewport pan and tab click anywhere in the workspace re-rendered it. The
 * view below is one small object that keeps its identity while nothing it
 * paints changed. Both halves matter and both fail silently: kept too
 * eagerly, the crumb shows an old name; dropped too eagerly, the bar is back
 * to re-rendering on every write.
 */
import { describe, expect, it } from "vitest";

import type { GroupRow, ProjectRow } from "../../lib/ipc";
import { titleBarSelector, titleBarView, type TitleBarSource } from "./view";

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

const project: ProjectRow = {
  id: "p1",
  name: "yard",
  path: "C:/Workspace/yard",
  color: null,
  icon: null,
  sort: 0,
  createdAt: 0,
};

function world(over: Partial<TitleBarSource> = {}): TitleBarSource {
  return {
    projects: [project],
    groups: [
      group("ground", {}, { mode: "auto", activeBySlot: { 0: "a" } }),
      group("board", { projectId: null, name: "Quadro" }, { canvas: { items: [] } }),
    ],
    activeGroupId: "ground",
    activeProjectId: "p1",
    groupBeforeBoard: null,
    ...over,
  };
}

/** The shape every store write has: the one row replaced, the others kept. */
function rewrite<T extends { id: string }>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

describe("titleBarView: what the bar paints", () => {
  it("names the active group, its project and the pane shape of the group on screen", () => {
    const view = titleBarView(
      world({
        groups: [group("ground", {}, { mode: "grid", panelCount: 4 })],
      }),
    );
    expect(view.group).toEqual({ id: "ground", name: "ground", projectId: "p1" });
    expect(view.project).toEqual(project);
    expect(view.controls).toEqual({ groupId: "ground", canvasActive: false });
    expect(view.layout).toEqual({ mode: "grid", panelCount: 4 });
  });

  it("on a board, the switch reads the group the user came from", () => {
    const state = world({
      activeGroupId: "board",
      groupBeforeBoard: "ground",
      groups: [
        group("ground", {}, { mode: "spotlight", panelCount: 3 }),
        group("board", { projectId: null, name: "Quadro" }),
      ],
    });
    const view = titleBarView(state);
    expect(view.group).toEqual({ id: "board", name: "Quadro", projectId: null });
    expect(view.project).toBeUndefined();
    expect(view.controls).toEqual({ groupId: "ground", canvasActive: true });
    expect(view.layout).toEqual({ mode: "spotlight", panelCount: 3 });
  });

  it("carries the floor of a project's group, the branch the crumb prints", () => {
    const floor = { kind: "isolated", branch: "feat", worktreePath: "C:/w/feat" };
    const view = titleBarView(world({ groups: [group("front", {}, { floor })], activeGroupId: "front" }));
    expect(view.floor).toEqual(floor);
  });

  it("with no group on screen, there is nothing to name and no switch", () => {
    const view = titleBarView(world({ activeGroupId: null }));
    expect(view.group).toBeNull();
    expect(view.project).toBeUndefined();
    expect(view.controls).toBeNull();
    expect(view.layout).toBeNull();
  });
});

describe("titleBarSelector: the same view while nothing painted changed", () => {
  it("keeps the view when a board's canvas is rewritten (a keystroke in a note)", () => {
    const select = titleBarSelector();
    const state = world();
    const before = select(state);
    const after = select({
      ...state,
      groups: rewrite(state.groups, "board", {
        layoutJson: JSON.stringify({ canvas: { items: [{ id: "n", text: "a" }] } }),
      }),
    });
    expect(after).toBe(before);
  });

  it("keeps the view when the board on screen is the one being typed into", () => {
    const select = titleBarSelector();
    const state = world({ activeGroupId: "board", groupBeforeBoard: "ground" });
    const before = select(state);
    const after = select({
      ...state,
      groups: rewrite(state.groups, "board", {
        layoutJson: JSON.stringify({ canvas: { viewport: { x: 10, y: 0, zoom: 1 } } }),
      }),
    });
    expect(after).toBe(before);
  });

  it("keeps the view on a tab switch in the group on screen", () => {
    const select = titleBarSelector();
    const state = world();
    const before = select(state);
    const after = select({
      ...state,
      groups: rewrite(state.groups, "ground", {
        layoutJson: JSON.stringify({ mode: "auto", activeBySlot: { 0: "b" } }),
      }),
    });
    expect(after).toBe(before);
  });

  it("hands out a new view when the active group is renamed", () => {
    const select = titleBarSelector();
    const state = world();
    const before = select(state);
    const after = select({ ...state, groups: rewrite(state.groups, "ground", { name: "main" }) });
    expect(after).not.toBe(before);
    expect(after.group?.name).toBe("main");
  });

  it("hands out a new view when the pane mode or the pane count changes", () => {
    const select = titleBarSelector();
    const state = world();
    const before = select(state);
    const grid = select({
      ...state,
      groups: rewrite(state.groups, "ground", {
        layoutJson: JSON.stringify({ mode: "grid", activeBySlot: { 0: "a" } }),
      }),
    });
    expect(grid).not.toBe(before);
    expect(grid.layout?.mode).toBe("grid");
    const six = select({
      ...state,
      groups: rewrite(state.groups, "ground", {
        layoutJson: JSON.stringify({ mode: "grid", panelCount: 6, activeBySlot: { 0: "a" } }),
      }),
    });
    expect(six).not.toBe(grid);
    expect(six.layout?.panelCount).toBe(6);
  });

  it("hands out a new view when the project on screen is renamed or restyled", () => {
    const select = titleBarSelector();
    const state = world();
    const before = select(state);
    const renamed = select({ ...state, projects: [{ ...project, name: "yard-2" }] });
    expect(renamed).not.toBe(before);
    expect(renamed.project?.name).toBe("yard-2");
    const coloured = select({ ...state, projects: [{ ...project, name: "yard-2", color: "#f00" }] });
    expect(coloured).not.toBe(renamed);
  });

  it("hands out a new view when the floor's branch changes or another group comes on screen", () => {
    const select = titleBarSelector();
    const state = world();
    const before = select(state);
    const branched = select({
      ...state,
      groups: rewrite(state.groups, "ground", {
        layoutJson: JSON.stringify({ floor: { kind: "isolated", branch: "x" } }),
      }),
    });
    expect(branched).not.toBe(before);
    expect(branched.floor).toEqual({ kind: "isolated", branch: "x" });
    const moved = select({ ...state, activeGroupId: "board" });
    expect(moved.group?.id).toBe("board");
  });
});
