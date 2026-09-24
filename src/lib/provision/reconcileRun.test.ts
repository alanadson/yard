/**
 * The boot's reading of every project's fronts, against git and the disk.
 *
 * It runs as the loading screen gives way to the tree, and the tree asks git
 * the same question about the same projects at the same moment. Every
 * `git worktree list` is two processes, and one project after another is a
 * wait that grows with the workspace. What is locked here is that the reading
 * shares the tree's listing, asks about every project at once, and still
 * reports in project order, so the toast says the same sentence whatever
 * order git happens to answer in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  worktreeList: vi.fn(),
  isDirectory: vi.fn(),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
}));

vi.mock("../ipc", () => ({ ipc: ipcMock }));

import { reconcileFronts } from "./reconcileRun";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { useWorktrees } from "../../stores/worktreesStore";

type Entry = { path: string; branch: string | null; bare: boolean };

/** Every listing waits for the test to answer it, keyed by the folder asked about. */
function holdListings() {
  const waiting: { path: string; answer: (entries: Entry[]) => void }[] = [];
  ipcMock.worktreeList.mockImplementation(
    (path: string) =>
      new Promise<Entry[]>((resolve) => {
        waiting.push({ path, answer: resolve });
      }),
  );
  /** Only the project's own checkout: the front's worktree is gone from git too. */
  const answer = (path: string) => {
    for (const w of waiting.filter((x) => x.path === path)) {
      w.answer([{ path, branch: "main", bare: false }]);
    }
  };
  return { waiting, answer };
}

/** Projects whose one front each lost its folder: the case the toast is for. */
function workspace(...names: string[]): string[] {
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
  return names.map((name) => {
    const s = useProjects.getState();
    const id = s.addProject(name, `C:/w/${name}`)!;
    s.addGroup(id, `${name}-front`, {
      activate: false,
      layout: {
        floor: { kind: "isolated", branch: `yard/${name}`, worktreePath: `C:/w/${name}-front` },
      },
    });
    return id;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The projects are on the disk; the fronts' folders are not.
  ipcMock.isDirectory.mockImplementation(async (path: string) => !path.endsWith("-front"));
  useWorktrees.setState({ byProject: {} });
  useUI.setState({ toasts: [] });
});

describe("the boot's reading of the fronts", () => {
  it("shares one git listing with the tree when both ask about a project at boot", async () => {
    const [api] = workspace("api");
    const held = holdListings();

    const reading = reconcileFronts();
    // The tree mounts once the loading screen goes, a moment later.
    await Promise.resolve();
    const tree = useWorktrees.getState().refresh(api, "C:/w/api");
    held.answer("C:/w/api");
    await Promise.all([reading, tree]);

    expect(ipcMock.worktreeList).toHaveBeenCalledTimes(1);
  });

  it("asks git about every project before the first one answers", async () => {
    workspace("api", "web", "docs");
    const held = holdListings();

    const reading = reconcileFronts();
    await vi.waitFor(() => expect(ipcMock.worktreeList).toHaveBeenCalledTimes(3), { timeout: 200 });

    for (const name of ["api", "web", "docs"]) held.answer(`C:/w/${name}`);
    await reading;
  });

  it("names the hurt fronts in project order, whatever order git answers in", async () => {
    workspace("api", "web");
    const held = holdListings();

    const reading = reconcileFronts();
    await vi.waitFor(() => expect(held.waiting).toHaveLength(2), { timeout: 200 });
    held.answer("C:/w/web");
    // Every other mock answers at once, so one turn of the event loop runs
    // the second project's reading to its end before the first one is heard.
    await new Promise((resolve) => setTimeout(resolve, 0));
    held.answer("C:/w/api");
    await reading;

    expect(useUI.getState().toasts.map((toast) => toast.message)).toEqual([
      'Frentes fora do lugar: api: "api-front" perdeu a pasta. Nada foi apagado. | ' +
        'web: "web-front" perdeu a pasta. Nada foi apagado.',
    ]);
  });
});
