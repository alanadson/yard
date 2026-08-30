/**
 * Closing a floor is the most destructive operation in the app: it kills
 * processes, deletes a worktree from disk and takes the group with it. The
 * order in which that happens is the contract.
 *
 * The regression this locks out: `teardown` — the hook that exists to clean
 * up what the floor left behind (`npm run clean`, a container still up) — ran
 * **after** the worktree was deleted, and with the ground's `cwd` on top of
 * that. The README promises the opposite ("hooks run in the worktree"), setup
 * and run already did it right, and the failure only showed up in `yard.log`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    worktreeDirty: vi.fn(async () => false),
    scmPushDelete: vi.fn(async () => undefined),
    worktreeRemove: vi.fn(async (): Promise<{ branchKept: string | null }> => ({
      branchKept: null,
    })),
    floorRunHook: vi.fn(async (_cwd: string, _cmd: string) => ({ code: 0, output: "" })),
    killPty: vi.fn(async () => undefined),
    ptyExists: vi.fn(async () => false),
    forgetPty: vi.fn(async () => undefined),
    portalRetain: vi.fn(async () => 0),
    saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 2 })),
    writePref: vi.fn(async () => undefined),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  },
}));

vi.mock("./ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));

import { closeFloor, closeFloorWarning } from "./floorClose";
import { DEFAULT_LAYOUT, useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";
import type { GroupRow, ProjectRow } from "./ipc";

vi.stubGlobal("window", { dispatchEvent: vi.fn() });

/** What reached the screen, so a silent failure cannot pass for a success. */
const toasts: { text: string; kind?: string }[] = [];

const project: ProjectRow = {
  id: "p1",
  name: "Projeto",
  path: "C:/proj",
  color: null,
  icon: null,
  sort: 0,
  createdAt: 1,
};

const group: GroupRow = {
  id: "g-frente",
  projectId: "p1",
  name: "Correção",
  layoutJson: JSON.stringify({
    ...DEFAULT_LAYOUT,
    floor: {
      kind: "isolated",
      branch: "yard/correcao",
      worktreePath: "C:/proj/.yard/floors/correcao",
      hooks: { setup: [], run: [], teardown: ["npm run clean"] },
    },
  }),
  suspended: false,
  sort: 0,
};

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  vi.clearAllMocks();
  useUI.setState({
    showToast: (text: string, kind?: string) => {
      toasts.push({ text, ...(kind ? { kind } : {}) });
    },
  } as never);
  ipcMock.worktreeDirty.mockImplementation(async () => {
    calls.push("dirty");
    return false;
  });
  ipcMock.worktreeRemove.mockImplementation(async () => {
    calls.push("remove");
    return { branchKept: null };
  });
  ipcMock.floorRunHook.mockImplementation(async (cwd: string, cmd: string) => {
    calls.push(`hook:${cmd}@${cwd}`);
    return { code: 0, output: "" };
  });
  useProjects.setState({
    rev: 1,
    loaded: true,
    loadError: null,
    saveError: null,
    projects: [project],
    groups: [group],
    terminals: [],
    activeProjectId: "p1",
    activeGroupId: "g-frente",
  });
});

describe("closing a floor", () => {
  it("runs teardown before deleting the worktree, and inside it", async () => {
    await closeFloor({ project, group, deleteBranch: false });

    expect(calls).toEqual([
      "dirty",
      "hook:npm run clean@C:/proj/.yard/floors/correcao",
      "remove",
    ]);
  });

  it("the group disappears at the end, hook or no hook", async () => {
    await closeFloor({ project, group, deleteBranch: false });
    expect(useProjects.getState().groups).toEqual([]);
  });
});

/**
 * The regression this locks down: "apagar a branch" ran `git branch -D`,
 * which takes whatever is on the branch. On a front nobody had landed that
 * was an afternoon of an agent's commits, held nowhere else, gone with no way
 * back. The backend refuses that now; what is owed here is the sentence, or
 * the person closes ten fronts believing ten branches went with them.
 */
describe("a branch the ground does not have yet", () => {
  it("is kept by the backend, and the person is told, not left to find out", async () => {
    ipcMock.worktreeRemove.mockImplementation(async () => {
      calls.push("remove");
      return { branchKept: "error: the branch 'yard/correcao' is not fully merged" };
    });

    await closeFloor({ project, group, deleteBranch: true });

    const said = toasts.map((t) => t.text).join(" | ");
    expect(said).toContain("yard/correcao");
    // The front is gone either way: only the branch survived.
    expect(useProjects.getState().groups).toEqual([]);
  });

  it("says nothing when the branch really did go", async () => {
    ipcMock.worktreeRemove.mockImplementation(async () => {
      calls.push("remove");
      return { branchKept: null };
    });
    await closeFloor({ project, group, deleteBranch: true });
    expect(toasts).toEqual([]);
  });
});

/**
 * What the Yard did not create, the Yard does not delete.
 *
 * A front can now open on a worktree that was already on the disk, one git
 * knows about, made here or by hand months ago, which the Yard only adopts.
 * Closing that front takes the group, the cards and the canvas; the folder
 * stays, because removing it would delete work the app never provisioned and
 * cannot bring back.
 */
describe("closing a front that only adopted its worktree", () => {
  const adopted: GroupRow = {
    ...group,
    id: "g-adotada",
    name: "Hotfix",
    layoutJson: JSON.stringify({
      ...DEFAULT_LAYOUT,
      floor: {
        kind: "isolated",
        branch: "hotfix",
        worktreePath: "D:/tmp/hotfix",
        adopted: true,
      },
    }),
  };

  beforeEach(() => {
    useProjects.setState({ groups: [adopted] });
  });

  it("leaves the worktree on the disk", async () => {
    await closeFloor({ project, group: adopted, deleteBranch: false });
    expect(ipcMock.worktreeRemove).not.toHaveBeenCalled();
  });

  it("still refuses to close over uncommitted work", async () => {
    ipcMock.worktreeDirty.mockImplementation(async () => true);
    await expect(
      closeFloor({ project, group: adopted, deleteBranch: false }),
    ).rejects.toThrow(/não commitado/);
  });

  it("still takes the group with it", async () => {
    await closeFloor({ project, group: adopted, deleteBranch: false });
    expect(useProjects.getState().groups).toEqual([]);
  });

  it("says so in the confirmation, instead of promising a deletion it will not do", () => {
    const text = closeFloorWarning(adopted, { kind: "isolated", branch: "hotfix", worktreePath: "D:/tmp/hotfix", adopted: true }, 0);
    expect(text).not.toContain("apagado do disco");
    expect(text).toContain("D:/tmp/hotfix");
  });
});

/**
 * The other half of "apagar a branch".
 *
 * A front's branch is born local and only reaches the server if somebody
 * pushed it. When somebody did, closing the front deleted the local copy and
 * left the published one standing. Ten fronts later the server holds ten
 * branches nobody meant to keep, and the person who cleans them up is not the
 * one who made them.
 *
 * The safety rule is the whole feature: the branch on the server is deleted
 * **only** when the local delete really happened. `git branch -d` refusing is
 * git saying "there are commits here the ground does not have", and in that
 * case the published copy is the only other place that work exists.
 */
describe("the branch that was published", () => {
  const origin = { remote: "origin", branch: "yard/correcao" };

  it("goes from the server too, when that is what was asked", async () => {
    await closeFloor({ project, group, deleteBranch: true, deleteRemote: origin });
    expect(ipcMock.scmPushDelete).toHaveBeenCalledWith("C:/proj", "origin", "yard/correcao");
  });

  it("survives on the server when the backend kept the local branch", async () => {
    ipcMock.worktreeRemove.mockImplementation(async () => ({
      branchKept: "error: the branch 'yard/correcao' is not fully merged",
    }));

    await closeFloor({ project, group, deleteBranch: true, deleteRemote: origin });

    expect(ipcMock.scmPushDelete).not.toHaveBeenCalled();
    const said = toasts.map((x) => x.text).join(" | ");
    expect(said).toContain("yard/correcao");
  });

  it("is left alone when nobody asked for it", async () => {
    await closeFloor({ project, group, deleteBranch: true });
    expect(ipcMock.scmPushDelete).not.toHaveBeenCalled();
  });

  it("a server that refuses does not undo the close, and does not go unsaid", async () => {
    ipcMock.scmPushDelete.mockImplementation(async () => {
      throw new Error("remote: permission denied");
    });

    await closeFloor({ project, group, deleteBranch: true, deleteRemote: origin });

    expect(useProjects.getState().groups).toEqual([]);
    const said = toasts.map((x) => x.text).join(" | ");
    expect(said).toContain("origin/yard/correcao");
    expect(said).toContain("permission denied");
  });
});
