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
    worktreeRemove: vi.fn(async () => undefined),
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

import { closeFloor } from "./floorClose";
import { DEFAULT_LAYOUT, useProjects } from "../stores/projectsStore";
import type { GroupRow, ProjectRow } from "./ipc";

vi.stubGlobal("window", { dispatchEvent: vi.fn() });

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
  id: "g-andar",
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
  vi.clearAllMocks();
  ipcMock.worktreeDirty.mockImplementation(async () => {
    calls.push("dirty");
    return false;
  });
  ipcMock.worktreeRemove.mockImplementation(async () => {
    calls.push("remove");
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
    activeGroupId: "g-andar",
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
