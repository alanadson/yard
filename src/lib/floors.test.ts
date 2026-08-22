import { describe, expect, it } from "vitest";

import {
  findGroupNamed,
  floorHookEnv,
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
 * The rule the "Criar andar" dialog and `yard floor create` share. Before,
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
