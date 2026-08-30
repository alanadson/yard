/**
 * One door for every caller.
 *
 * The dialog got the plan: the preflight, the collisions, the frozen base,
 * the journal that knows what to undo. `yard floor create`, "Nova aba" and
 * the fan-out did not: they called `worktree_provision` straight, with a
 * hand-written copy of two of the dialog's checks and none of the rest. So
 * the CLI could open a front on a branch already checked out somewhere,
 * discover it from git's stderr, and roll back with `git branch -D`, the one
 * command this whole design exists to avoid.
 *
 * What is locked here is that there is now no second way in: everything goes
 * through the plan, a plan that refuses writes nothing, and a `--dry-run`
 * leaves the repository exactly as it found it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  worktreePreflight: vi.fn(),
  worktreeProvision: vi.fn(),
  worktreeRemove: vi.fn(),
  branchDeleteIfUnchanged: vi.fn(),
  worktreeList: vi.fn(async () => []),
  detectAgents: vi.fn(async () => [] as unknown[]),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
}));

vi.mock("../ipc", () => ({ ipc: ipcMock }));

import { firstProblem, provisionFronts } from "./run";
import type { ProvisionEffects } from "./batch";
import { useProjects } from "../../stores/projectsStore";

const PROJECT = "C:/proj";
const OID = "a".repeat(40);

function freshProject(): string {
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
  return useProjects.getState().addProject("proj", PROJECT)!;
}

/** A repository with one commit, one branch and nothing in the way. */
function preflight(over: Record<string, unknown> = {}) {
  return {
    isRepo: true,
    hasHead: true,
    groundPath: PROJECT,
    groundBranch: "main",
    groundDirty: false,
    defaultBase: "main",
    localBranches: ["main"],
    worktrees: [{ path: PROJECT, branch: "main", bare: false }],
    items: [
      {
        id: "row",
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
      },
    ],
    ...over,
  };
}

/** Every write this batch could make, counted and never performed. */
function spyEffects(): ProvisionEffects & { made: string[] } {
  const made: string[] = [];
  return {
    made,
    refresh: async () => ipcMock.worktreePreflight(PROJECT, []) as never,
    createWorktree: async (item) => {
      made.push(`create:${item.path}`);
      return { path: item.path, branch: item.branch, headOid: OID };
    },
    registerGroup: async (item) => {
      made.push(`group:${item.displayName}`);
      return "g1";
    },
    runSetup: async () => {},
    launchAgent: async () => null,
    removeWorktree: async (p) => {
      made.push(`remove:${p}`);
    },
    deleteBranch: async () => true,
    dropGroup: async () => {},
    stopAgent: async () => {},
  };
}

beforeEach(() => {
  for (const fn of Object.values(ipcMock)) {
    if (typeof fn === "function" && "mockReset" in fn) (fn as { mockReset: () => void }).mockReset();
  }
  ipcMock.worktreePreflight.mockResolvedValue(preflight());
  ipcMock.detectAgents.mockResolvedValue([]);
  ipcMock.worktreeList.mockResolvedValue([]);
  ipcMock.saveWorkspace.mockResolvedValue({ accepted: true, rev: 1 });
  ipcMock.readPrefs.mockResolvedValue({});
});

describe("a dry run", () => {
  it("answers with the whole plan and does not write a thing", async () => {
    const projectId = freshProject();
    const fx = spyEffects();
    const run = await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "login" }],
      dryRun: true,
      effects: fx,
    });

    expect(run.plan.valid).toBe(true);
    expect(run.plan.items[0].branch).toBe("yard/login");
    expect(run.plan.items[0].base).toEqual({ ref: "main", oid: OID });
    // The two proofs that nothing happened: no report, and no effect.
    expect(run.report).toBeNull();
    expect(fx.made).toEqual([]);
    expect(useProjects.getState().groupsOf(projectId)).toHaveLength(1); // the ground
  });
});

describe("a plan the rules refuse", () => {
  /**
   * The regression that motivated the door: `yard floor create` carried its
   * own copy of two checks, so a branch already checked out in another front
   * was found by git, after the folder existed, in English.
   */
  it("never reaches the effects: the CLI cannot walk past a refusal", async () => {
    const projectId = freshProject();
    const fx = spyEffects();
    const run = await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "login" }],
      effects: fx,
    });
    expect(run.plan.valid).toBe(true);

    // Now the same name is taken by a front that already exists.
    useProjects.getState().addGroup(projectId, "login", { activate: false });
    const again = await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "Login" }],
      effects: fx,
    });

    expect(again.plan.valid).toBe(false);
    expect(again.report).toBeNull();
    expect(firstProblem(again)?.code).toBe("NAME_TAKEN");
    // One creation only: the first call. The refusal wrote nothing.
    expect(fx.made.filter((m) => m.startsWith("create:"))).toHaveLength(1);
  });

  it("reports two rows of one batch fighting over a branch, before git is asked once", async () => {
    const projectId = freshProject();
    const fx = spyEffects();
    ipcMock.worktreePreflight.mockResolvedValue(
      preflight({
        items: [
          preflight().items[0],
          { ...preflight().items[0], id: "row2" },
        ],
      }),
    );
    const run = await provisionFronts({
      projectId,
      fronts: [
        { id: "row", name: "login" },
        { id: "row2", name: "login 2" },
      ],
      effects: fx,
    });

    expect(run.plan.valid).toBe(false);
    expect(firstProblem(run)?.code).toBe("ITEM_BRANCH_COLLISION");
    expect(fx.made).toEqual([]);
  });
});

describe("a run that goes through", () => {
  it("registers the front the plan described and calls it ready", async () => {
    const projectId = freshProject();
    const fx = spyEffects();
    const run = await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "login" }],
      effects: fx,
    });

    expect(run.report?.state).toBe("succeeded");
    expect(run.report?.items[0].state).toBe("ready");
    expect(run.report?.items[0].groupId).toBe("g1");
    expect(fx.made).toEqual(["create:C:/proj/.yard/floors/login", "group:login"]);
    expect(firstProblem(run)).toBeNull();
  });

  /**
   * `--no-git` inside a repository. The front shares the ground's folder, so
   * nothing is created on the disk, and the path the group is registered at
   * has to be the ground's, not the `.yard/floors/login` the preflight
   * guessed for a row it did not know was plain.
   */
  it("opens a front asked for without git on the ground, creating no worktree", async () => {
    const projectId = freshProject();
    const fx = spyEffects();
    const run = await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "login", noGit: true }],
      effects: fx,
    });

    expect(run.plan.items[0].action).toBe("create_folder");
    expect(run.plan.items[0].path).toBe(PROJECT);
    expect(fx.made).toEqual(["group:login"]);
  });

  it("uses the app's own effects when none are handed to it", async () => {
    const projectId = freshProject();
    ipcMock.worktreeProvision.mockResolvedValue({
      path: "C:/proj/.yard/floors/login",
      branch: "yard/login",
      kind: "isolated",
      headOid: OID,
      baseOid: OID,
    });

    const run = await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "login" }],
    });

    expect(run.report?.items[0].state).toBe("ready");
    expect(ipcMock.worktreeProvision).toHaveBeenCalledWith(
      expect.objectContaining({ base: OID, worktreeName: "login" }),
    );
    const group = useProjects
      .getState()
      .groupsOf(projectId)
      .find((g) => g.name === "login");
    expect(group).toBeTruthy();
    expect(useProjects.getState().floorOf(group!.id)).toMatchObject({
      kind: "isolated",
      worktreePath: "C:/proj/.yard/floors/login",
    });
  });
});

describe("the agent a front is opened for", () => {
  it("is checked against what this machine actually has, before anything is created", async () => {
    const projectId = freshProject();
    const fx = spyEffects();
    ipcMock.detectAgents.mockResolvedValue([
      { id: "claude", name: "Claude Code", installed: true, bin: "claude.exe" },
    ]);

    const run = await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "login", agentId: "codex" }],
      effects: fx,
    });

    expect(firstProblem(run)?.code).toBe("AGENT_UNAVAILABLE");
    expect(fx.made).toEqual([]);
  });

  it("does not go looking for agents when no row asked for one", async () => {
    const projectId = freshProject();
    await provisionFronts({
      projectId,
      fronts: [{ id: "row", name: "login" }],
      dryRun: true,
      effects: spyEffects(),
    });
    expect(ipcMock.detectAgents).not.toHaveBeenCalled();
  });
});
