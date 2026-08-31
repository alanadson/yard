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
  spawnPty: vi.fn(async () => undefined),
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

/**
 * The regression that motivated this file's newest test: opening a front
 * dropped the user on the canvas. "Clonar o layout do chão" applied a
 * *score* — the canvas format — and a score, when it lands on an empty
 * group, turns that group to the canvas. So a worktree created to hold an
 * agent's panes opened on a board nobody had asked to see, with the ground's
 * CLIs nowhere in it. The canvas is its own place: nothing that creates a
 * front is allowed to walk into it.
 */
describe("cloning the ground", () => {
  it("copies the ground's panes and leaves the front on the grid — creating a front never opens the canvas", async () => {
    const projectId = freshProject();
    const s = useProjects.getState();
    const ground = s.groupsOf(projectId)[0];
    s.updateLayout(ground.id, { mode: "spotlight", panelCount: 3 });
    s.addTerminal({ groupId: ground.id, title: "dev", program: "pwsh.exe", cwd: PROJECT });
    s.addTerminal({ groupId: ground.id, title: "logs", program: "pwsh.exe", cwd: PROJECT, slot: 1 });

    const fx = yardEffects({ projectId, projectPath: PROJECT, copyGround: true });
    const groupId = await fx.registerGroup(item(), {
      path: "C:/proj/.yard/floors/login",
      branch: "yard/login",
      headOid: "abc",
    });

    const after = useProjects.getState();
    expect(after.layoutOf(groupId).surface).toBe("grid");
    expect(after.terminalsOn(groupId, "canvas")).toHaveLength(0);
    expect(after.terminalsOn(groupId, "grid").map((t) => t.title)).toEqual(["dev", "logs"]);
    expect(after.layoutOf(groupId).mode).toBe("spotlight");
    expect(after.layoutOf(groupId).panelCount).toBe(3);
  });

  it("gives the clones the front's own worktree as their working root", async () => {
    const projectId = freshProject();
    const s = useProjects.getState();
    const ground = s.groupsOf(projectId)[0];
    s.addTerminal({ groupId: ground.id, title: "dev", program: "pwsh.exe", cwd: PROJECT });

    const fx = yardEffects({ projectId, projectPath: PROJECT, copyGround: true });
    const groupId = await fx.registerGroup(item(), {
      path: "C:/proj/.yard/floors/login",
      branch: "yard/login",
      headOid: "abc",
    });

    const cwds = useProjects
      .getState()
      .terminalsOn(groupId, "grid")
      .map((t) => t.cwd);
    expect(cwds).toEqual(["C:/proj/.yard/floors/login"]);
  });

  it("leaves the ground's board out of it — a card is not a tab", async () => {
    const projectId = freshProject();
    const s = useProjects.getState();
    const ground = s.groupsOf(projectId)[0];
    s.addTerminal({
      groupId: ground.id,
      title: "card",
      program: "pwsh.exe",
      cwd: PROJECT,
      surface: "canvas",
    });

    const fx = yardEffects({ projectId, projectPath: PROJECT, copyGround: true });
    const groupId = await fx.registerGroup(item(), {
      path: "C:/proj/.yard/floors/login",
      branch: "yard/login",
      headOid: "abc",
    });

    const after = useProjects.getState();
    expect(after.terminalsOf(groupId)).toHaveLength(0);
    expect(after.layoutOf(groupId).surface).toBe("grid");
  });
});

describe("the agent the front was opened for", () => {
  it("comes up as a tab even with the ground showing its board — provisioning does not touch the canvas", async () => {
    const projectId = freshProject();
    const s = useProjects.getState();
    const ground = s.groupsOf(projectId)[0];
    s.updateLayout(ground.id, { surface: "canvas" });

    const fx = yardEffects({
      projectId,
      projectPath: PROJECT,
      agentBin: () => "claude.exe",
      agentName: () => "Claude",
    });
    const plan = item({ action: "use_ground", agentId: "claude" });
    const groupId = await fx.registerGroup(plan, { path: PROJECT, branch: "main", headOid: null });
    const terminalId = await fx.launchAgent(plan, groupId, {
      path: PROJECT,
      branch: "main",
      headOid: null,
    });

    const after = useProjects.getState();
    expect(groupId).toBe(ground.id);
    expect(after.terminal(terminalId!)?.surface).toBe("grid");
    expect(after.layoutOf(ground.id).canvas?.nodes ?? {}).toEqual({});
  });
});
