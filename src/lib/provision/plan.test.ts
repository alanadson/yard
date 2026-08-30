/**
 * The plan is what the dialog shows before anything is written: for every
 * row, the commit it grows from, the branch it makes, the folder it lands in,
 * and every reason it might be refused.
 *
 * Two halves feed it and neither is enough alone. Git answers what the
 * repository holds (`worktree_preflight`); the app answers what it holds
 * itself — which fronts already exist, which agent is alive where, which name
 * is spoken for. Only together do they see the failure that costs the most:
 * four rows of a batch each individually free, all four asking for the same
 * branch, because git is asked one at a time and says yes four times.
 *
 * The clock and the id come in as arguments. A plan that stamped itself with
 * `Date.now()` could not be tested for the one thing that matters about
 * staleness — that it expires.
 */
import { describe, expect, it } from "vitest";

import type { Preflight, PreflightItemResult } from "../ipc";
import { buildPlan, planIsStale, worldFingerprint, type PlanWorld, type TargetSpec } from "./plan";

const OID = "a".repeat(40);

function itemResult(over: Partial<PreflightItemResult> & { id: string }): PreflightItemResult {
  return {
    branch: "yard/login",
    branchExists: false,
    branchCheckedOutAt: null,
    branchError: null,
    path: "C:/proj/.yard/floors/login",
    pathExists: false,
    baseRef: "main",
    baseOid: OID,
    locked: null,
    dirty: null,
    ...over,
  };
}

function preflight(items: PreflightItemResult[], over: Partial<Preflight> = {}): Preflight {
  return {
    isRepo: true,
    hasHead: true,
    groundPath: "C:/proj",
    groundBranch: "main",
    groundDirty: false,
    defaultBase: "main",
    localBranches: ["main"],
    worktrees: [{ path: "C:/proj", branch: "main", bare: false }],
    items,
    ...over,
  };
}

const EMPTY_WORLD: PlanWorld = {
  takenNames: [],
  ownedPaths: {},
  busyPaths: {},
  availableAgents: ["codex", "claude"],
};

function row(over: Partial<TargetSpec> & { clientItemId: string }): TargetSpec {
  return {
    kind: "new_worktree_new_branch",
    displayName: "login",
    ...over,
  };
}

const plan = (
  specs: TargetSpec[],
  pf: Preflight,
  world: Partial<PlanWorld> = {},
  now = 1_000,
) =>
  buildPlan({
    planId: "plan_1",
    revision: 1,
    now,
    specs,
    preflight: pf,
    world: { ...EMPTY_WORLD, ...world },
  });

const codes = (list: { code: string }[]) => list.map((i) => i.code);

describe("a plan for one row", () => {
  it("prints the resolved base, branch and folder — the three the dialog promises", () => {
    const p = plan([row({ clientItemId: "a" })], preflight([itemResult({ id: "a" })]));
    expect(p.valid).toBe(true);
    expect(p.items[0].branch).toBe("yard/login");
    expect(p.items[0].base).toEqual({ ref: "main", oid: OID });
    expect(p.items[0].path).toBe("C:/proj/.yard/floors/login");
    expect(p.items[0].action).toBe("create_worktree");
  });

  it("refuses a nameless front, pointing at the field to fix", () => {
    const p = plan([row({ clientItemId: "a", displayName: "  " })], preflight([itemResult({ id: "a" })]));
    expect(p.valid).toBe(false);
    expect(codes(p.items[0].errors)).toContain("NAME_REQUIRED");
    expect(p.items[0].errors[0].field).toBe("name");
  });

  it("refuses a name another front of the project already answers to", () => {
    const p = plan(
      [row({ clientItemId: "a", displayName: "login" })],
      preflight([itemResult({ id: "a" })]),
      { takenNames: ["Login"] },
    );
    // Case-insensitively: two fronts called `login` and `Login` are two rows
    // nobody can tell apart in the tree.
    expect(codes(p.items[0].errors)).toContain("NAME_TAKEN");
  });

  it("carries git's own refusal of a branch name, before the click", () => {
    const p = plan(
      [row({ clientItemId: "a", branchName: "--force" })],
      preflight([itemResult({ id: "a", branch: "--force", branchError: "começa com -" })]),
    );
    expect(codes(p.items[0].errors)).toContain("BRANCH_INVALID");
  });

  it("refuses to create a branch that already exists, and says what to do instead", () => {
    const p = plan(
      [row({ clientItemId: "a" })],
      preflight([itemResult({ id: "a", branch: "main", branchExists: true })]),
    );
    expect(codes(p.items[0].errors)).toContain("BRANCH_ALREADY_EXISTS");
  });

  it("refuses a base that resolves to no commit", () => {
    const p = plan(
      [row({ clientItemId: "a", baseRef: "origin/nope" })],
      preflight([itemResult({ id: "a", baseRef: "origin/nope", baseOid: null })]),
    );
    expect(codes(p.items[0].errors)).toContain("BASE_UNRESOLVED");
  });

  it("refuses a folder that already holds something", () => {
    const p = plan([row({ clientItemId: "a" })], preflight([itemResult({ id: "a", pathExists: true })]));
    expect(codes(p.items[0].errors)).toContain("WORKTREE_PATH_CONFLICT");
  });

  it("refuses to start in a repository with no commit yet", () => {
    const p = plan([row({ clientItemId: "a" })], preflight([itemResult({ id: "a" })], { hasHead: false }));
    expect(codes(p.items[0].errors)).toContain("REPO_WITHOUT_COMMIT");
  });

  it("a folder with no git is not an error — it is a front with no isolation, said out loud", () => {
    const p = plan(
      [row({ clientItemId: "a" })],
      preflight([itemResult({ id: "a" })], { isRepo: false, hasHead: false }),
    );
    expect(p.valid).toBe(true);
    expect(p.items[0].action).toBe("create_folder");
    expect(codes(p.items[0].warnings)).toContain("NOT_A_REPO");
  });

  /**
   * `yard floor create --no-git` inside a repository that *does* have git. The
   * person asked for a front with no branch of its own, and the plan has to
   * promise the ground's own folder: a path under `.yard/floors/` would be a
   * folder nothing ever creates, and the setup hook would be sent to it.
   */
  it("honours a front asked for with no git, landing it on the ground instead of a worktree", () => {
    const p = plan(
      [row({ clientItemId: "a", noGit: true })],
      preflight([itemResult({ id: "a" })]),
    );
    expect(p.valid).toBe(true);
    expect(p.items[0].action).toBe("create_folder");
    expect(p.items[0].path).toBe("C:/proj");
    expect(p.items[0].branch).toBeNull();
    // The warning belongs to a folder that *cannot* have git, not to somebody
    // who chose not to use it.
    expect(codes(p.items[0].warnings)).not.toContain("NOT_A_REPO");
  });
});

describe("a plan on a branch that already exists", () => {
  const existing = (over: Partial<TargetSpec> = {}) =>
    row({ clientItemId: "a", kind: "new_worktree_existing_branch", branchName: "feature/x", ...over });

  it("needs a branch chosen — an empty field is a refusal, not a default", () => {
    const p = plan(
      [existing({ branchName: "" })],
      preflight([itemResult({ id: "a", branch: null })]),
    );
    expect(codes(p.items[0].errors)).toContain("BRANCH_REQUIRED");
  });

  it("refuses a branch that is not in the repository any more", () => {
    const p = plan(
      [existing()],
      preflight([itemResult({ id: "a", branch: "feature/x", branchExists: false })]),
    );
    expect(codes(p.items[0].errors)).toContain("BRANCH_MISSING");
  });

  it("names the worktree already holding it, instead of forwarding git's sentence", () => {
    const p = plan(
      [existing({ branchName: "main" })],
      preflight([
        itemResult({
          id: "a",
          branch: "main",
          branchExists: true,
          branchCheckedOutAt: "C:/proj",
        }),
      ]),
    );
    const issue = p.items[0].errors.find((e) => e.code === "BRANCH_ALREADY_CHECKED_OUT");
    expect(issue?.vars).toEqual({ branch: "main", path: "C:/proj" });
  });

  it("grows no branch, so it has no base to freeze", () => {
    const p = plan(
      [existing()],
      preflight([itemResult({ id: "a", branch: "feature/x", branchExists: true, baseRef: null, baseOid: null })]),
    );
    expect(p.items[0].base).toBe(null);
    expect(p.items[0].action).toBe("create_worktree");
  });
});

describe("a plan that adopts a worktree already on the disk", () => {
  const adopt = (over: Partial<TargetSpec> = {}) =>
    row({
      clientItemId: "a",
      kind: "existing_worktree",
      worktreePath: "C:/proj/.yard/floors/solta",
      ...over,
    });

  const listed = (over: Partial<PreflightItemResult> = {}) =>
    itemResult({
      id: "a",
      branch: "yard/solta",
      branchExists: true,
      branchCheckedOutAt: "C:/proj/.yard/floors/solta",
      path: "C:/proj/.yard/floors/solta",
      pathExists: true,
      baseRef: null,
      baseOid: null,
      ...over,
    });

  it("adopts instead of creating: nothing is written, so nothing is rolled back", () => {
    const p = plan([adopt()], preflight([listed()]));
    expect(p.valid).toBe(true);
    expect(p.items[0].action).toBe("adopt_worktree");
    expect(p.items[0].branch).toBe("yard/solta");
  });

  it("does not read its own branch as taken — it is taken *by the thing being adopted*", () => {
    const p = plan([adopt()], preflight([listed()]));
    expect(codes(p.items[0].errors)).not.toContain("BRANCH_ALREADY_CHECKED_OUT");
  });

  it("needs a worktree chosen", () => {
    const p = plan([adopt({ worktreePath: "" })], preflight([listed({ path: "", pathExists: false })]));
    expect(codes(p.items[0].errors)).toContain("WORKTREE_REQUIRED");
  });

  it("refuses one git no longer lists", () => {
    const p = plan([adopt()], preflight([listed({ pathExists: false })]));
    expect(codes(p.items[0].errors)).toContain("WORKTREE_MISSING");
  });

  it("refuses one another front already works in — two fronts, one folder", () => {
    const p = plan([adopt()], preflight([listed()]), {
      ownedPaths: { "c:/proj/.yard/floors/solta": "revisão" },
    });
    const issue = p.items[0].errors.find((e) => e.code === "WORKTREE_ADOPTED");
    expect(issue?.vars).toEqual({ name: "revisão" });
  });

  it("refuses one that is locked, with the reason whoever locked it wrote", () => {
    const p = plan([adopt()], preflight([listed({ locked: "pen drive" })]));
    expect(codes(p.items[0].errors)).toContain("WORKTREE_LOCKED");
  });

  it("only warns about uncommitted work: the agent is meant to start on top of it", () => {
    const p = plan([adopt()], preflight([listed({ dirty: true })]));
    expect(p.valid).toBe(true);
    expect(codes(p.items[0].warnings)).toContain("WORKTREE_DIRTY");
  });

  it("warns when an agent is already alive there — git isolates nothing inside one folder", () => {
    const p = plan([adopt()], preflight([listed()]), {
      busyPaths: { "c:/proj/.yard/floors/solta": 1 },
    });
    expect(p.valid).toBe(true);
    expect(codes(p.items[0].warnings)).toContain("WORKTREE_SHARED");
  });
});

describe("a plan that uses the project's own checkout", () => {
  const ground = row({ clientItemId: "a", kind: "current_workspace" });
  const atGround = itemResult({
    id: "a",
    branch: "main",
    branchExists: true,
    branchCheckedOutAt: "C:/proj",
    path: "C:/proj",
    pathExists: true,
    baseRef: null,
    baseOid: null,
  });

  it("creates nothing and never swaps the branch", () => {
    const p = plan([ground], preflight([atGround]));
    expect(p.valid).toBe(true);
    expect(p.items[0].action).toBe("use_ground");
    expect(p.items[0].branch).toBe("main");
  });

  it("says out loud that the agent will edit the same files the person has open", () => {
    const p = plan([ground], preflight([atGround]));
    expect(codes(p.items[0].warnings)).toContain("GROUND_IN_USE");
  });

  it("does not ask for a name: the ground is already named after its branch", () => {
    const p = plan([row({ clientItemId: "a", kind: "current_workspace", displayName: "" })], preflight([atGround]));
    expect(codes(p.items[0].errors)).not.toContain("NAME_REQUIRED");
  });
});

describe("the agent chosen for a row", () => {
  it("refuses one that is not installed on this machine", () => {
    const p = plan([row({ clientItemId: "a", agentId: "gemini" })], preflight([itemResult({ id: "a" })]));
    const issue = p.items[0].errors.find((e) => e.code === "AGENT_UNAVAILABLE");
    expect(issue?.field).toBe("agent");
  });

  it("accepts a row with no agent at all — a front may be opened for a person", () => {
    const p = plan([row({ clientItemId: "a", agentId: null })], preflight([itemResult({ id: "a" })]));
    expect(p.valid).toBe(true);
  });
});

describe("the collisions only the batch can see", () => {
  it("catches two rows asking for the same branch, which git would allow one at a time", () => {
    const p = plan(
      [row({ clientItemId: "a", displayName: "um", branchName: "agent/login" }),
       row({ clientItemId: "b", displayName: "dois", branchName: "agent/login" })],
      preflight([
        itemResult({ id: "a", branch: "agent/login", path: "C:/w/a" }),
        itemResult({ id: "b", branch: "agent/login", path: "C:/w/b" }),
      ]),
    );
    expect(p.valid).toBe(false);
    // Both rows, not just the second: the person has to see which two clash.
    expect(codes(p.items[0].errors)).toContain("ITEM_BRANCH_COLLISION");
    expect(codes(p.items[1].errors)).toContain("ITEM_BRANCH_COLLISION");
  });

  it("catches two rows asking for the same folder", () => {
    const p = plan(
      [row({ clientItemId: "a", displayName: "um" }), row({ clientItemId: "b", displayName: "dois" })],
      preflight([
        itemResult({ id: "a", branch: "yard/a", path: "C:/w/same" }),
        itemResult({ id: "b", branch: "yard/b", path: "C:/w/same" }),
      ]),
    );
    expect(codes(p.items[0].errors)).toContain("ITEM_PATH_COLLISION");
  });

  it("catches two rows asking for the same name", () => {
    const p = plan(
      [row({ clientItemId: "a", displayName: "login" }), row({ clientItemId: "b", displayName: "Login" })],
      preflight([
        itemResult({ id: "a", branch: "yard/a", path: "C:/w/a" }),
        itemResult({ id: "b", branch: "yard/b", path: "C:/w/b" }),
      ]),
    );
    expect(codes(p.items[0].errors)).toContain("ITEM_NAME_COLLISION");
  });

  it("two rows sent to one existing worktree is a warning, not a refusal — but it is said", () => {
    const shared = {
      kind: "existing_worktree" as const,
      worktreePath: "C:/proj/.yard/floors/solta",
    };
    const listed = (id: string) =>
      itemResult({
        id,
        branch: "yard/solta",
        branchExists: true,
        branchCheckedOutAt: "C:/proj/.yard/floors/solta",
        path: "C:/proj/.yard/floors/solta",
        pathExists: true,
        baseRef: null,
        baseOid: null,
      });
    const p = plan(
      [row({ clientItemId: "a", displayName: "um", ...shared }),
       row({ clientItemId: "b", displayName: "dois", ...shared })],
      preflight([listed("a"), listed("b")]),
    );
    expect(p.valid).toBe(true);
    expect(codes(p.items[0].warnings)).toContain("WORKTREE_SHARED");
    expect(codes(p.items[1].warnings)).toContain("WORKTREE_SHARED");
  });

  it("a row git already refused is not also blamed for colliding with itself", () => {
    const p = plan([row({ clientItemId: "a" })], preflight([itemResult({ id: "a" })]));
    expect(codes(p.items[0].errors)).toEqual([]);
  });
});

describe("staleness", () => {
  it("expires: a plan read and left on screen must be built again before it writes", () => {
    const p = plan([row({ clientItemId: "a" })], preflight([itemResult({ id: "a" })]), {}, 1_000);
    expect(planIsStale(p, p.expiresAt - 1)).toBe(false);
    expect(planIsStale(p, p.expiresAt + 1)).toBe(true);
  });

  it("notices the repository moving under it — a branch created elsewhere while the dialog waited", () => {
    const before = preflight([itemResult({ id: "a" })]);
    const after = preflight([itemResult({ id: "a" })], {
      localBranches: ["main", "yard/login"],
    });
    expect(worldFingerprint(before)).not.toBe(worldFingerprint(after));
  });

  it("does not fire on a listing that only came back in another order", () => {
    const a = preflight([itemResult({ id: "a" })], { localBranches: ["main", "dev"] });
    const b = preflight([itemResult({ id: "a" })], { localBranches: ["dev", "main"] });
    expect(worldFingerprint(a)).toBe(worldFingerprint(b));
  });

  it("the fingerprint travels with the plan, so the executor can compare without keeping the old one", () => {
    const pf = preflight([itemResult({ id: "a" })]);
    const p = plan([row({ clientItemId: "a" })], pf);
    expect(p.fingerprint).toBe(worldFingerprint(pf));
  });
});
