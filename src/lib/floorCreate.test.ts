/**
 * Opening a front, in the two shapes it has: git makes a worktree, or the
 * worktree is already on the disk and the Yard only adopts it.
 *
 * Adoption is the half that is easy to get wrong quietly. `git worktree add`
 * on a folder that exists fails loudly; *not* calling it and writing the group
 * anyway fails silently, and if two groups end up pointing at the same
 * worktree, closing either one deletes the files under the other.
 *
 * Since this became a shim over `provisionFronts`, the other half of the file
 * is that there is no shortcut left: every refusal the dialog would have
 * shown reaches this caller too, and it reaches it *before* git is asked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { worktreeProvision, worktreeRemove, worktreePreflight, detectAgents } = vi.hoisted(() => ({
  worktreeProvision: vi.fn(),
  worktreeRemove: vi.fn(),
  worktreePreflight: vi.fn(),
  detectAgents: vi.fn(async () => [] as unknown[]),
}));

vi.mock("./ipc", () => ({
  ipc: {
    worktreeProvision,
    worktreeRemove,
    worktreePreflight,
    detectAgents,
    saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
    writePref: vi.fn(async () => undefined),
  },
}));

import { createFloor } from "./floorCreate";
import { useProjects } from "../stores/projectsStore";

const PROJECT = "C:/Workspace/yard";
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
  return useProjects.getState().addProject("yard", PROJECT)!;
}

/**
 * What the backend would answer about the one row `createFloor` sends. The id
 * is `front` because that is the single row this shim builds.
 */
function preflight(item: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
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
        id: "front",
        branch: "yard/nova",
        branchExists: false,
        branchCheckedOutAt: null,
        branchError: null,
        path: `${PROJECT}/.yard/floors/nova`,
        pathExists: false,
        baseRef: "main",
        baseOid: OID,
        locked: null,
        dirty: null,
        ...item,
      },
    ],
    ...over,
  };
}

/** The answer for a row that adopts the worktree already sitting at `path`. */
const adoptable = (path: string, branch: string) =>
  preflight(
    { branch, branchExists: true, path, pathExists: true, baseRef: null, baseOid: null },
    { worktrees: [{ path: PROJECT, branch: "main", bare: false }, { path, branch, bare: false }] },
  );

beforeEach(() => {
  worktreeProvision.mockReset();
  worktreeRemove.mockReset();
  worktreePreflight.mockReset();
  worktreePreflight.mockResolvedValue(preflight());
  worktreeProvision.mockResolvedValue({
    path: `${PROJECT}/.yard/floors/nova`,
    branch: "yard/nova",
    kind: "isolated",
    headOid: OID,
    baseOid: OID,
  });
});

describe("opening a front on a worktree that already exists", () => {
  it("does not ask git to add one, because the folder is already there", async () => {
    const projectId = freshProject();
    worktreePreflight.mockResolvedValue(adoptable("D:/tmp/hotfix", "hotfix"));

    const { groupId, provision } = await createFloor({
      projectId,
      name: "hotfix",
      adopt: { path: "D:/tmp/hotfix", branch: "hotfix" },
      activate: false,
    });

    expect(worktreeProvision).not.toHaveBeenCalled();
    expect(provision).toEqual({ path: "D:/tmp/hotfix", branch: "hotfix", kind: "isolated" });
    expect(useProjects.getState().floorOf(groupId)).toMatchObject({
      kind: "isolated",
      branch: "hotfix",
      worktreePath: "D:/tmp/hotfix",
      // What the Yard did not create, the Yard never deletes.
      adopted: true,
    });
  });

  /**
   * The regression this locks down: two groups on the same worktree means
   * closing one of them removes the files the other is still working in.
   */
  it("refuses a worktree another front already opened, whatever the slashes and case", async () => {
    const projectId = freshProject();
    worktreePreflight.mockResolvedValue(adoptable("D:/tmp/hotfix", "hotfix"));
    await createFloor({
      projectId,
      name: "hotfix",
      adopt: { path: "D:/tmp/hotfix", branch: "hotfix" },
      activate: false,
    });
    const before = useProjects.getState().groupsOf(projectId).length;

    worktreePreflight.mockResolvedValue(adoptable("d:\\tmp\\hotfix\\", "hotfix"));
    await expect(
      createFloor({
        projectId,
        name: "hotfix de novo",
        adopt: { path: "d:\\tmp\\hotfix\\", branch: "hotfix" },
        activate: false,
      }),
    ).rejects.toThrow(/hotfix/);
    expect(useProjects.getState().groupsOf(projectId)).toHaveLength(before);
  });

  it("keeps the name rule of every other front: no two groups with one name", async () => {
    const projectId = freshProject();
    await createFloor({ projectId, name: "hotfix", activate: false });
    worktreePreflight.mockResolvedValue(adoptable("D:/tmp/hotfix", "hotfix"));
    await expect(
      createFloor({
        projectId,
        name: "  HOTFIX ",
        adopt: { path: "D:/tmp/hotfix", branch: "hotfix" },
        activate: false,
      }),
    ).rejects.toThrow(/hotfix/i);
  });

  it("still goes through git when no worktree was handed to it", async () => {
    const projectId = freshProject();
    await createFloor({ projectId, name: "nova", activate: false });
    expect(worktreeProvision).toHaveBeenCalledOnce();
  });
});

describe("the refusals this caller used to find out about from git", () => {
  /**
   * The regression that motivated routing this through the plan: `yard floor
   * create` carried its own two checks and none of the rest, so a branch
   * already checked out in another worktree was discovered by `git worktree
   * add`, after the fact, in English, naming a path nobody had typed.
   */
  it("refuses a branch already checked out somewhere, before git is asked to add anything", async () => {
    const projectId = freshProject();
    worktreePreflight.mockResolvedValue(
      preflight({
        branch: "feature/login",
        branchExists: true,
        branchCheckedOutAt: "D:/tmp/login",
        baseRef: null,
        baseOid: null,
      }),
    );

    await expect(
      createFloor({
        projectId,
        name: "login",
        branch: "feature/login",
        existingBranch: true,
        activate: false,
      }),
    ).rejects.toThrow(/D:\/tmp\/login/);
    expect(worktreeProvision).not.toHaveBeenCalled();
  });

  it("carries the base the plan froze into the creation, so the disk matches the plan", async () => {
    const projectId = freshProject();
    await createFloor({ projectId, name: "nova", activate: false });
    expect(worktreeProvision).toHaveBeenCalledWith(
      expect.objectContaining({ base: OID, worktreeName: "nova" }),
    );
  });
});
