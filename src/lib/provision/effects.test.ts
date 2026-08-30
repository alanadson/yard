/**
 * The boundary: where the plan stops being a decision and becomes a folder on
 * the disk. Everything past `ipc` is mocked here, because what is worth
 * locking is not that git works — it is *what we ask git for*.
 *
 * Two of these are the reason the file exists at all. The creation has to
 * carry the plan's own base and folder, or the disk quietly gets something
 * other than the screen promised. And the rollback has to remove the worktree
 * **without** `git branch -D` riding along, because the branch delete is a
 * separate, guarded step: `-D` deletes whatever is there, and what is there
 * may be a commit an agent just made.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  worktreeProvision: vi.fn(),
  worktreeRemove: vi.fn(),
  branchDeleteIfUnchanged: vi.fn(),
  worktreeList: vi.fn(async () => []),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
}));

vi.mock("../ipc", () => ({ ipc: ipcMock }));

import { yardEffects } from "./effects";
import type { PlannedItem } from "./plan";
import { useProjects } from "../../stores/projectsStore";

const PROJECT = "C:/proj";

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

function item(over: Partial<PlannedItem> = {}): PlannedItem {
  return {
    clientItemId: "a",
    kind: "new_worktree_new_branch",
    action: "create_worktree",
    displayName: "login",
    branch: "yard/login",
    base: { ref: "main", oid: "abc" },
    path: "C:/proj/.yard/floors/login",
    errors: [],
    warnings: [],
    agentId: null,
    prompt: "",
    ...over,
  };
}

beforeEach(() => {
  ipcMock.worktreeProvision.mockReset();
  ipcMock.worktreeRemove.mockReset();
  ipcMock.branchDeleteIfUnchanged.mockReset();
  ipcMock.worktreeProvision.mockResolvedValue({
    path: "C:/proj/.yard/floors/login",
    branch: "yard/login",
    kind: "isolated",
    headOid: "abc",
    baseOid: "abc",
  });
  ipcMock.branchDeleteIfUnchanged.mockResolvedValue(true);
});

describe("creating the worktree the plan described", () => {
  it("passes the frozen base and the chosen folder, so the disk matches the screen", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    await fx.createWorktree(item());
    expect(ipcMock.worktreeProvision).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT,
        branch: "yard/login",
        base: "abc",
        worktreeName: "login",
        existingBranch: false,
      }),
    );
  });

  it("asks for a checkout of an existing branch instead of a new one", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    await fx.createWorktree(item({ kind: "new_worktree_existing_branch", base: null }));
    expect(ipcMock.worktreeProvision).toHaveBeenCalledWith(
      expect.objectContaining({ existingBranch: true, base: null }),
    );
  });

  it("hands back the OID the worktree was born at — the rollback compares against it", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    expect(await fx.createWorktree(item())).toEqual({
      path: "C:/proj/.yard/floors/login",
      branch: "yard/login",
      headOid: "abc",
    });
  });
});

describe("registering the front", () => {
  it("writes a front that knows its worktree and its branch", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    const groupId = await fx.registerGroup(item(), {
      path: "C:/proj/.yard/floors/login",
      branch: "yard/login",
      headOid: "abc",
    });
    const floor = useProjects.getState().floorOf(groupId);
    expect(floor.kind).toBe("isolated");
    expect(floor.worktreePath).toBe("C:/proj/.yard/floors/login");
    expect(floor.branch).toBe("yard/login");
    expect(floor.adopted).toBeUndefined();
  });

  it("marks an adopted worktree as adopted — what the Yard did not make, it never deletes", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    const groupId = await fx.registerGroup(item({ action: "adopt_worktree" }), {
      path: "C:/proj/.yard/floors/solta",
      branch: "yard/solta",
      headOid: null,
    });
    expect(useProjects.getState().floorOf(groupId).adopted).toBe(true);
  });

  it("reuses the ground instead of creating a second group over the same folder", async () => {
    const projectId = freshProject();
    const ground = useProjects.getState().groupsOf(projectId)[0];
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    const groupId = await fx.registerGroup(item({ action: "use_ground" }), {
      path: PROJECT,
      branch: "main",
      headOid: null,
    });
    expect(groupId).toBe(ground.id);
    expect(useProjects.getState().groupsOf(projectId)).toHaveLength(1);
  });
});

describe("undoing", () => {
  it("removes the worktree and leaves the branch strictly alone", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    await fx.removeWorktree("C:/proj/.yard/floors/login");
    // The third argument is the branch to delete. It stays null: `branch -D`
    // takes whatever is on the branch with it, and by now that may be a
    // commit an agent made a second ago.
    expect(ipcMock.worktreeRemove).toHaveBeenCalledWith(
      PROJECT,
      "C:/proj/.yard/floors/login",
      null,
    );
  });

  it("deletes the branch only through the compare-and-swap", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    ipcMock.branchDeleteIfUnchanged.mockResolvedValue(false);
    expect(await fx.deleteBranch("yard/login", "abc")).toBe(false);
    expect(ipcMock.branchDeleteIfUnchanged).toHaveBeenCalledWith(PROJECT, "yard/login", "abc");
  });

  it("refuses to delete a branch with no OID to compare against, rather than guessing", async () => {
    const projectId = freshProject();
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    expect(await fx.deleteBranch("yard/login", "")).toBe(false);
    expect(ipcMock.branchDeleteIfUnchanged).not.toHaveBeenCalled();
  });

  it("drops the group it registered — and never the ground", async () => {
    const projectId = freshProject();
    const ground = useProjects.getState().groupsOf(projectId)[0];
    const fx = yardEffects({ projectId, projectPath: PROJECT });
    const groupId = await fx.registerGroup(item(), {
      path: "C:/proj/.yard/floors/login",
      branch: "yard/login",
      headOid: "abc",
    });
    await fx.dropGroup(groupId);
    expect(useProjects.getState().groupsOf(projectId).map((g) => g.id)).toEqual([ground.id]);

    await fx.dropGroup(ground.id);
    expect(useProjects.getState().groupsOf(projectId)).toHaveLength(1);
  });
});
