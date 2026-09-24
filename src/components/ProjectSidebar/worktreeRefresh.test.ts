// A floor change must refresh its project without spawning Git for every project.
import { describe, expect, it } from "vitest";
import { worktreeRefreshPlan } from "./worktreeRefresh";

describe("worktree refresh planning", () => {
  it("refreshes only the project whose groups changed", () => {
    const projects = [
      { id: "a", path: "C:/a" },
      { id: "b", path: "C:/b" },
    ];
    const groups = [
      { id: "one", projectId: "a" },
      { id: "two", projectId: "b" },
    ];
    const initial = worktreeRefreshPlan(new Map(), projects, groups);
    const changed = worktreeRefreshPlan(initial.scopes, projects, [
      ...groups,
      { id: "three", projectId: "a" },
      { id: "board", projectId: null },
    ]);
    expect(changed.refresh).toEqual([projects[0]]);
    expect(changed.forget).toEqual([]);
    expect(
      worktreeRefreshPlan(changed.scopes, projects, [
        { id: "board", projectId: null },
        ...groups,
        { id: "three", projectId: "a" },
      ]).refresh,
    ).toEqual([]);
  });
});
