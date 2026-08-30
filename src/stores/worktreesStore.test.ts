/**
 * What `git worktree list` said about each project, kept in one place.
 *
 * Three screens need the same answer: the tree (which branch is each row
 * on), "Nova aba" (where does this CLI run) and "Abrir frente" (which
 * worktrees are still free to adopt). Asking git three times, once per
 * dialog, is three processes for one fact.
 *
 * The rule that matters is what happens when the listing fails: git is not
 * there, the folder was renamed, the repository is mid-rebase. Emptying the
 * cache would take the branch off every row in the tree and make every
 * adoptable worktree disappear from the pickers, which reads as "this project
 * has no branches", a lie. The last good answer stays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { worktreeList } = vi.hoisted(() => ({ worktreeList: vi.fn() }));

vi.mock("../lib/ipc", () => ({ ipc: { worktreeList } }));

import { useWorktrees } from "./worktreesStore";

const ENTRIES = [
  { path: "C:/Workspace/yard", branch: "main", bare: false },
  { path: "C:/Workspace/yard/.yard/floors/fix", branch: "yard/fix", bare: false },
];

beforeEach(() => {
  worktreeList.mockReset();
  useWorktrees.setState({ byProject: {} });
});

describe("the worktrees of a project", () => {
  it("are what git listed, keyed by project", async () => {
    worktreeList.mockResolvedValue(ENTRIES);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    expect(useWorktrees.getState().of("p1")).toEqual(ENTRIES);
    expect(worktreeList).toHaveBeenCalledWith("C:/Workspace/yard");
  });

  it("are an empty list for a project nobody asked about yet", () => {
    expect(useWorktrees.getState().of("nunca-vista")).toEqual([]);
  });

  /** The regression: a failed listing used to read as "no branches here". */
  it("keep the last good answer when the listing fails", async () => {
    worktreeList.mockResolvedValue(ENTRIES);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    worktreeList.mockRejectedValue(new Error("git nao esta no PATH"));
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    expect(useWorktrees.getState().of("p1")).toEqual(ENTRIES);
  });

  it("are empty for a project with no git, where git lists nothing and that is an answer", async () => {
    worktreeList.mockResolvedValue([]);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/sem-git");
    expect(useWorktrees.getState().of("p1")).toEqual([]);
  });

  it("go away with the project, so a re-added folder is listed again", async () => {
    worktreeList.mockResolvedValue(ENTRIES);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    useWorktrees.getState().forget("p1");
    expect(useWorktrees.getState().of("p1")).toEqual([]);
  });

  it("keeps the same array between reads so a selector does not re-render the tree", async () => {
    worktreeList.mockResolvedValue(ENTRIES);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    expect(useWorktrees.getState().of("p1")).toBe(useWorktrees.getState().of("p1"));
  });

  /**
   * The tree refreshes this on every group born or closed, and every project
   * at once. Writing an equal list back would hand each subscriber a new array
   * identity and repaint the whole sidebar for nothing.
   */
  it("a refresh that finds the same worktrees writes nothing", async () => {
    worktreeList.mockResolvedValue(ENTRIES);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    const first = useWorktrees.getState().of("p1");
    worktreeList.mockResolvedValue(ENTRIES.map((e) => ({ ...e })));
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    expect(useWorktrees.getState().of("p1")).toBe(first);
  });

  it("a worktree that appeared does replace the list", async () => {
    worktreeList.mockResolvedValue(ENTRIES);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    const first = useWorktrees.getState().of("p1");
    worktreeList.mockResolvedValue([...ENTRIES, { path: "D:/novo", branch: "novo", bare: false }]);
    await useWorktrees.getState().refresh("p1", "C:/Workspace/yard");
    expect(useWorktrees.getState().of("p1")).not.toBe(first);
    expect(useWorktrees.getState().of("p1")).toHaveLength(3);
  });

  /** The same empty list for every project nobody listed: one identity. */
  it("hands the same empty list to every project it knows nothing about", () => {
    expect(useWorktrees.getState().of("a")).toBe(useWorktrees.getState().of("b"));
  });
});
