import { describe, expect, it } from "vitest";

import {
  findGroupNamed,
  floorHookEnv,
  groupLabel,
  isBranchNamed,
  normalizeFloor,
  parseHookLines,
  uniqueFloorName,
} from "./floors";

describe("normalizeFloor", () => {
  it("preserves a complete isolated floor", () => {
    const floor = normalizeFloor({
      kind: "isolated",
      branch: "yard/fix-login",
      worktreePath: "C:\\proj\\.yard\\floors\\fix-login",
      hooks: { setup: ["npm ci"], run: ["npm run dev"], teardown: [], autoSetup: true },
    });
    expect(floor).toEqual({
      kind: "isolated",
      branch: "yard/fix-login",
      worktreePath: "C:\\proj\\.yard\\floors\\fix-login",
      hooks: { setup: ["npm ci"], run: ["npm run dev"], teardown: [], autoSetup: true },
    });
  });

  it("discards an unknown kind and structural garbage", () => {
    expect(normalizeFloor(undefined)).toBeUndefined();
    expect(normalizeFloor(null)).toBeUndefined();
    expect(normalizeFloor("isolated")).toBeUndefined();
    expect(normalizeFloor({ kind: "penthouse" })).toBeUndefined();
    expect(normalizeFloor({ branch: "x" })).toBeUndefined();
  });

  it("cleans crooked fields without dropping the rest", () => {
    const floor = normalizeFloor({
      kind: "plain",
      branch: "   ",
      worktreePath: 42,
      hooks: { setup: [1, "ok", ""], run: "npm run dev", teardown: null },
    });
    // Invalid branch/worktreePath disappear; hooks keeps only what is usable.
    expect(floor).toEqual({ kind: "plain", hooks: { setup: ["ok"], run: [], teardown: [] } });
  });

  it("fully empty hooks do not even enter the object", () => {
    const floor = normalizeFloor({ kind: "ground", hooks: { setup: [], run: [], teardown: [] } });
    expect(floor).toEqual({ kind: "ground" });
  });

  /**
   * The golden rule of this file, and the one that decides whether a front
   * deletes a folder it never made: a field `normalizeFloor` does not copy is
   * gone on the next save. `adopted` says the worktree was on the disk before
   * the front, so closing it must leave the folder alone. Dropped here, the
   * flag survives exactly until the first layout write and then the front
   * starts deleting the user's own worktree.
   */
  it("keeps `adopted`, the flag that says the worktree is not ours to delete", () => {
    const floor = normalizeFloor({
      kind: "isolated",
      branch: "hotfix",
      worktreePath: "D:/tmp/hotfix",
      adopted: true,
    });
    expect(floor).toEqual({
      kind: "isolated",
      branch: "hotfix",
      worktreePath: "D:/tmp/hotfix",
      adopted: true,
    });
  });

  it("does not invent `adopted` out of a crooked value", () => {
    expect(normalizeFloor({ kind: "isolated", worktreePath: "D:/x", adopted: "sim" })).toEqual({
      kind: "isolated",
      worktreePath: "D:/x",
    });
    expect(normalizeFloor({ kind: "isolated", worktreePath: "D:/x" })).toEqual({
      kind: "isolated",
      worktreePath: "D:/x",
    });
  });
});

describe("floorHookEnv", () => {
  it("builds the five variables, with an empty branch when there is none", () => {
    const env = floorHookEnv({
      floorName: "fix-login",
      floorPath: "C:\\proj\\.yard\\floors\\fix-login",
      rootPath: "C:\\proj",
      projectName: "Meu Projeto",
    });
    expect(env).toEqual([
      ["YARD_FLOOR_NAME", "fix-login"],
      ["YARD_BRANCH_NAME", ""],
      ["YARD_FLOOR_PATH", "C:\\proj\\.yard\\floors\\fix-login"],
      ["YARD_ROOT_PATH", "C:\\proj"],
      ["YARD_PROJECT_NAME", "Meu Projeto"],
    ]);
  });
});

describe("parseHookLines", () => {
  it("one line per command, no blanks", () => {
    expect(parseHookLines("npm ci\n\n  npm run build  \n")).toEqual([
      "npm ci",
      "npm run build",
    ]);
  });
});

/**
 * The rule the "Abrir frente" dialog and `yard floor create` share. Before,
 * only the CLI checked, and a "sem git" floor never even reached the backend —
 * two groups with the same name left `floor list` and `recruit --floor`
 * ambiguous.
 */
describe("normalizeFloor task", () => {
  it("preserves the fan-out task", () => {
    const floor = normalizeFloor({
      kind: "isolated",
      branch: "yard/t",
      worktreePath: "C:\\p\\.yard\\floors\\t",
      agentId: "claude",
      task: { id: "abc", prompt: "arruma o login", createdAt: 1 },
    });
    expect(floor?.task).toEqual({
      id: "abc",
      prompt: "arruma o login",
      createdAt: 1,
    });
    expect(floor?.agentId).toBe("claude");
  });

  it("discards a task without id or prompt", () => {
    expect(
      normalizeFloor({ kind: "isolated", task: { prompt: "x", createdAt: 1 } })
        ?.task,
    ).toBeUndefined();
    expect(
      normalizeFloor({ kind: "isolated", task: { id: "a", createdAt: 1 } })?.task,
    ).toBeUndefined();
  });
});

describe("uniqueFloorName", () => {
  it("returns the name if nobody has it", () => {
    expect(uniqueFloorName([{ name: "Chao" }], "fix · Claude")).toBe(
      "fix · Claude",
    );
  });

  it("appends (2) when the name already exists", () => {
    expect(
      uniqueFloorName([{ name: "fix · Claude" }], "fix · Claude"),
    ).toBe("fix · Claude (2)");
    expect(
      uniqueFloorName(
        [{ name: "fix · Claude" }, { name: "fix · Claude (2)" }],
        "fix · Claude",
      ),
    ).toBe("fix · Claude (3)");
  });
});

describe("findGroupNamed", () => {
  const groups = [{ name: "Principal" }, { name: "Fix login" }];

  it("finds ignoring case and surrounding space", () => {
    expect(findGroupNamed(groups, "fix login")?.name).toBe("Fix login");
    expect(findGroupNamed(groups, "  FIX LOGIN  ")?.name).toBe("Fix login");
  });

  it("a name that does not exist gives null, and an empty name never matches", () => {
    expect(findGroupNamed(groups, "outro")).toBeNull();
    expect(findGroupNamed(groups, "   ")).toBeNull();
    expect(findGroupNamed([{ name: "  " }], "")).toBeNull();
  });

  it("does not match by prefix — only the whole name", () => {
    expect(findGroupNamed(groups, "fix")).toBeNull();
  });
});

/**
 * What a row calls a group.
 *
 * A project's children are branches now, so the ground has no name of its own
 * to invent: it is the project root, and the root is on a branch. The row
 * prints that branch, and the stored name ("Principal", whatever someone typed
 * once) stops being shown at all. Renaming it here would be a lie in both
 * directions: the label would stop matching the branch, and the branch would
 * not move. The only way to change it is `git branch -m`, in Controle.
 *
 * A front keeps its own name, which is the task, with its branch beside it; a
 * project with no git keeps whatever the group was called, because there is no
 * branch to take the name from.
 */
describe("groupLabel", () => {
  it("calls the ground by the branch checked out at the project root", () => {
    expect(groupLabel({ name: "Principal", floor: { kind: "ground" }, groundBranch: "main" })).toBe(
      "main",
    );
  });

  it("keeps a front on its own name, the task it was opened for", () => {
    expect(
      groupLabel({
        name: "fix-login",
        floor: { kind: "isolated", branch: "yard/fix-login", worktreePath: "C:/w/f" },
        groundBranch: "main",
      }),
    ).toBe("fix-login");
  });

  it("falls back to the stored name when git named no branch", () => {
    expect(groupLabel({ name: "Principal", floor: { kind: "ground" }, groundBranch: null })).toBe(
      "Principal",
    );
  });

  it("leaves the folder-groups of before on their own name", () => {
    expect(groupLabel({ name: "Grupo 2", floor: { kind: "plain" }, groundBranch: "main" })).toBe(
      "Grupo 2",
    );
  });

  it("never answers empty, whatever is in the row", () => {
    expect(groupLabel({ name: "  ", floor: { kind: "ground" }, groundBranch: null })).not.toBe("");
  });
});

describe("isBranchNamed", () => {
  it("is the ground with a branch, the one row whose name is not the user's to type", () => {
    expect(isBranchNamed({ kind: "ground" }, "main")).toBe(true);
  });

  it("is not the ground of a project with no git, which keeps a name of its own", () => {
    expect(isBranchNamed({ kind: "ground" }, null)).toBe(false);
  });

  it("is not a front: its name is the task, and the branch shows beside it", () => {
    expect(
      isBranchNamed({ kind: "isolated", branch: "yard/fix", worktreePath: "C:/w" }, "main"),
    ).toBe(false);
  });

  it("is not a folder-group of before", () => {
    expect(isBranchNamed({ kind: "plain" }, "main")).toBe(false);
  });
});
