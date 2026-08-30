/**
 * What the app knows that git does not, boiled down to the four facts the
 * planner needs.
 *
 * Git can say a worktree exists; only the app can say a front already works
 * in it. Git can say a branch is checked out; only the app can say there is
 * an agent alive in that folder right now. Both halves are needed, and both
 * used to be re-derived, slightly differently, in each of the three screens
 * that asked.
 */
import { describe, expect, it } from "vitest";

import { GROUND_FLOOR, type FloorMeta } from "../floors";
import { specsToPreflight, worldFrom, type WorldInput } from "./world";
import type { TargetSpec } from "./plan";

const PROJECT = "C:/proj";

const floors: Record<string, FloorMeta> = {
  ground: GROUND_FLOOR,
  frente: { kind: "isolated", branch: "yard/login", worktreePath: "C:/proj/.yard/floors/login" },
  adotada: { kind: "isolated", branch: "yard/solta", worktreePath: "C:/proj/.yard/floors/solta", adopted: true },
};

function world(over: Partial<WorldInput> = {}) {
  const input: WorldInput = {
    projectId: "p1",
    projectPath: PROJECT,
    groups: [
      { id: "ground", projectId: "p1", name: "main" },
      { id: "frente", projectId: "p1", name: "Login" },
      { id: "outro", projectId: "p2", name: "de outro projeto" },
    ],
    floorOf: (id) => floors[id] ?? GROUND_FLOOR,
    terminals: [],
    availableAgents: ["codex"],
    ...over,
  };
  return worldFrom(input);
}

describe("the names already spoken for", () => {
  it("takes the fronts of this project and no other's", () => {
    expect(world().takenNames).toEqual(["main", "Login"]);
  });
});

describe("the worktrees a front already owns", () => {
  it("keys them by root, so C:/Proj and c:/proj are one folder", () => {
    expect(world().ownedPaths["c:/proj/.yard/floors/login"]).toBe("Login");
  });

  it("counts an adopted worktree as owned — two fronts in one folder is the failure", () => {
    const w = world({
      groups: [{ id: "adotada", projectId: "p1", name: "Solta" }],
    });
    expect(w.ownedPaths["c:/proj/.yard/floors/solta"]).toBe("Solta");
  });

  it("leaves the ground out: it is not a worktree anybody adopted", () => {
    expect(world().ownedPaths["c:/proj"]).toBeUndefined();
  });
});

describe("where an agent is alive right now", () => {
  it("counts the running terminals of a front against the front's own folder", () => {
    const w = world({
      terminals: [
        { id: "t1", groupId: "frente", alive: true },
        { id: "t2", groupId: "frente", alive: true },
        { id: "t3", groupId: "frente", alive: false },
      ],
    });
    expect(w.busyPaths["c:/proj/.yard/floors/login"]).toBe(2);
  });

  it("counts a terminal of the ground against the project's own root", () => {
    const w = world({ terminals: [{ id: "t1", groupId: "ground", alive: true }] });
    expect(w.busyPaths["c:/proj"]).toBe(1);
  });

  it("says nothing about a folder with nobody in it, rather than zero", () => {
    // A `0` and an absent key read the same to the planner, but the absent
    // key is what keeps the object the size of what is actually running.
    expect(world().busyPaths).toEqual({});
  });
});

describe("the rows on their way to the backend", () => {
  const spec = (over: Partial<TargetSpec> & { clientItemId: string }): TargetSpec => ({
    kind: "new_worktree_new_branch",
    displayName: "login",
    ...over,
  });

  it("translates each shape into the word the backend understands", () => {
    const rows = specsToPreflight([
      spec({ clientItemId: "a" }),
      spec({ clientItemId: "b", kind: "new_worktree_existing_branch", branchName: "feature/x" }),
      spec({ clientItemId: "c", kind: "existing_worktree", worktreePath: "C:/w" }),
      spec({ clientItemId: "d", kind: "current_workspace" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["new_branch", "existing_branch", "adopt", "ground"]);
  });

  it("sends the typed fields and nothing invented in their place", () => {
    const [row] = specsToPreflight([
      spec({ clientItemId: "a", branchName: " agent/login ", worktreeName: "login", baseRef: "origin/main" }),
    ]);
    expect(row).toEqual({
      id: "a",
      kind: "new_branch",
      name: "login",
      branch: "agent/login",
      worktreeName: "login",
      baseRef: "origin/main",
      worktreePath: null,
    });
  });

  it("sends an untouched field as null, which is the backend's cue to derive it", () => {
    const [row] = specsToPreflight([spec({ clientItemId: "a", branchName: "   " })]);
    expect(row.branch).toBe(null);
    expect(row.worktreeName).toBe(null);
  });
});
