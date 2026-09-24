/**
 * The live feed reducer.
 *
 * Order is the contract here: the panel renders the array as it comes, so
 * "most recently touched at the top" has to survive a batch that re-touches
 * paths already in the list. The dedup rule matters too — a file created and
 * then modified in the same session is still *new*, and the badge must say so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diffRevisionOf, fetchDiff, useChanges } from "./changesStore";
import { ipc } from "../lib/ipc";
import type { FileEvent, FilesActivity } from "../lib/ipc";

const PROJ = "p1";

function activity(events: FileEvent[], dropped = 0): FilesActivity {
  return { projectId: PROJ, root: "C:\\repo", events, dropped };
}

function ev(path: string, kind: FileEvent["kind"], at: number): FileEvent {
  return { path, kind, at };
}

function feed() {
  return useChanges.getState().liveByProject[PROJ] ?? [];
}

function reset() {
  useChanges.setState({
    watched: { [PROJ]: "C:\\repo" },
    liveByProject: {},
    droppedByProject: {},
  });
}

describe("applyActivity", () => {
  it("lists the most recent first", () => {
    reset();
    useChanges.getState().applyActivity(
      activity([ev("a.ts", "modified", 1), ev("b.ts", "modified", 2)]),
    );
    expect(feed().map((e) => e.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("moves a re-touched path back to the top without reshuffling the rest", () => {
    reset();
    const s = useChanges.getState();
    s.applyActivity(
      activity([
        ev("a.ts", "modified", 1),
        ev("b.ts", "modified", 2),
        ev("c.ts", "modified", 3),
      ]),
    );
    expect(feed().map((e) => e.path)).toEqual(["c.ts", "b.ts", "a.ts"]);

    s.applyActivity(activity([ev("a.ts", "modified", 4)]));
    expect(feed().map((e) => e.path)).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  it("counts every batch that touched a path", () => {
    reset();
    const s = useChanges.getState();
    s.applyActivity(activity([ev("a.ts", "modified", 1)]));
    s.applyActivity(activity([ev("a.ts", "modified", 2)]));
    s.applyActivity(activity([ev("a.ts", "modified", 3)]));
    expect(feed()).toHaveLength(1);
    expect(feed()[0].count).toBe(3);
    expect(feed()[0].at).toBe(3);
  });

  it("keeps a created file marked as created after a modification", () => {
    reset();
    const s = useChanges.getState();
    s.applyActivity(activity([ev("novo.ts", "created", 1)]));
    s.applyActivity(activity([ev("novo.ts", "modified", 2)]));
    expect(feed()[0].kind).toBe("created");
  });

  it("lets a delete override anything before it", () => {
    reset();
    const s = useChanges.getState();
    s.applyActivity(activity([ev("x.ts", "created", 1)]));
    s.applyActivity(activity([ev("x.ts", "deleted", 2)]));
    expect(feed()[0].kind).toBe("deleted");
  });

  it("accumulates the dropped counter across batches", () => {
    reset();
    const s = useChanges.getState();
    s.applyActivity(activity([ev("a.ts", "modified", 1)], 5));
    s.applyActivity(activity([ev("b.ts", "modified", 2)], 7));
    expect(useChanges.getState().droppedByProject[PROJ]).toBe(12);
  });

  it("ignores a late event from the previous worktree", () => {
    reset();
    useChanges.getState().applyActivity({
      ...activity([ev("src/App.tsx", "modified", 1)]),
      root: "C:\\repo\\.yard\\old-floor",
    });
    expect(feed()).toEqual([]);
  });
});

/**
 * The regression this locks: removing a project cleared the store's own keys
 * (`watched`, `watchDesired`) *before* the App effect ran `syncWatches`, so the
 * id was no longer "known" and `unwatch_project` was never sent. The backend
 * watcher — a `notify` handle plus its thread — stayed alive for the rest of
 * the session, and every batch it emitted rebuilt the feed of a project nobody
 * could see and scheduled `git status` on a folder that had left the workspace.
 */
describe("a project leaving the workspace", () => {
  // A pending read must not recreate state after the project has been removed.
  it("does not restore a removed project when an older Git read finishes", async () => {
    reset();
    let finish!: (value: import("../lib/ipc").ChangesSummary) => void;
    vi.spyOn(ipc, "gitChanges").mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    vi.spyOn(ipc, "unwatchProject").mockResolvedValue(undefined);
    try {
      const pending = useChanges.getState().refreshGit(PROJ, "C:/repo");
      useChanges.getState().dropProject(PROJ);
      finish({ isRepo: false, branch: null, files: [], additions: 0, deletions: 0, uncounted: 0 });
      await pending;
      expect(useChanges.getState().gitByProject[PROJ]).toBeUndefined();
      expect(useChanges.getState().gitLoading[PROJ]).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("dropProject tells the backend to stop watching the folder", async () => {
    reset();
    const calls: string[] = [];
    vi.spyOn(ipc, "unwatchProject").mockImplementation(async (id: string) => {
      calls.push(id);
    });

    useChanges.getState().dropProject(PROJ);

    expect(calls).toEqual([PROJ]);
    vi.restoreAllMocks();
  });

  it("activity from a project that already left is discarded", () => {
    reset();
    vi.spyOn(ipc, "unwatchProject").mockResolvedValue(undefined);
    useChanges.getState().dropProject(PROJ);

    useChanges.getState().applyActivity(activity([ev("a.ts", "modified", 1)]));

    expect(useChanges.getState().liveByProject[PROJ]).toBeUndefined();
    vi.restoreAllMocks();
  });
});

/**
 * A `git status` only becomes new state when the summary's fingerprint
 * changes — without that, every tick of the watcher rebuilt the list and
 * invalidated every cached diff.
 *
 * The trap this test locks: **staging a hunk of a file changes nothing the
 * old fingerprint looked at.** A `.M` file that becomes `MM` has the same
 * `status` ("modified"), the same path and the same +/− (which is counted
 * against `HEAD`, and `HEAD` did not move). Only the two sides — index and
 * disk — changed. With them left out, the Source Control tab kept showing
 * the file in the group it was in before the click.
 */
describe("refreshGit", () => {
  // A read started before the activity event cannot satisfy the next revision.
  it("starts a fresh diff read after invalidation while an older read is pending", async () => {
    const projectId = "pending-diff";
    useChanges.setState({ watched: { [projectId]: "C:/repo" } });
    vi.useFakeTimers();
    const file = { path: "a.ts", untracked: false };
    const result = (text: string): import("../lib/ipc").FileDiff => ({
      path: file.path, text, isBinary: false, truncated: false, external: false,
    });
    let finish!: (value: import("../lib/ipc").FileDiff) => void;
    vi.spyOn(ipc, "gitFileDiff")
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue(result("new text"));
    try {
      const older = fetchDiff(projectId, "C:/repo", file, false);
      useChanges.getState().applyActivity({
        projectId, root: "C:/repo", events: [ev("a.ts", "modified", 1)], dropped: 0,
      });
      const newer = fetchDiff(projectId, "C:/repo", file, false);
      finish(result("old text"));
      await older;
      expect((await newer).text).toBe("new text");
      expect((await fetchDiff(projectId, "C:/repo", file, false)).text).toBe("new text");
    } finally {
      vi.spyOn(ipc, "unwatchProject").mockResolvedValue(undefined);
      useChanges.getState().dropProject(projectId);
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("keeps unrelated diffs cached when a file activity batch arrives", async () => {
    const projectId = "selective-cache";
    useChanges.setState({ watched: { [projectId]: "C:/repo" } });
    vi.useFakeTimers();
    const read = vi.spyOn(ipc, "gitFileDiff").mockImplementation(async (_root, path) => ({
      path, text: path, isBinary: false, truncated: false, external: false,
    }));
    try {
      const file = { path: "b.ts", untracked: false };
      const previous = await fetchDiff(projectId, "C:/repo", file, false);
      useChanges.getState().applyActivity({
        projectId, root: "C:/repo", events: [ev("a.ts", "modified", 1)], dropped: 0,
      });
      expect(await fetchDiff(projectId, "C:/repo", file, false)).toBe(previous);
    } finally {
      vi.spyOn(ipc, "unwatchProject").mockResolvedValue(undefined);
      useChanges.getState().dropProject(projectId);
      read.mockRestore();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  const summary = (over: Partial<import("../lib/ipc").ChangedFile> = {}) => ({
    isRepo: true,
    branch: "main",
    additions: 3,
    deletions: 1,
    uncounted: 0,
    files: [
      {
        path: "a.ts",
        origPath: null,
        status: "modified" as const,
        staged: false,
        additions: 3,
        deletions: 1,
        binary: false,
        index: "none" as const,
        worktree: "modified" as const,
        conflict: null,
        ...over,
      },
    ],
  });

  it("notifies open diff views when content changes but the Git summary stays equal", async () => {
    reset();
    vi.useFakeTimers();
    vi.spyOn(ipc, "gitChanges").mockResolvedValue(summary());
    try {
      await useChanges.getState().refreshGit(PROJ, "C:/repo");
      const previous = useChanges.getState().gitByProject[PROJ];
      const revision = useChanges.getState().diffRevisionByProject?.[PROJ] ?? 0;
      useChanges.getState().applyActivity(activity([ev("a.ts", "modified", 1)]));
      await vi.advanceTimersByTimeAsync(1200);
      expect(useChanges.getState().gitByProject[PROJ]).toBe(previous);
      expect(useChanges.getState().diffRevisionByProject?.[PROJ]).toBeGreaterThan(revision);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("refreshes diff content on an explicit Git refresh with unchanged status", async () => {
    reset();
    vi.spyOn(ipc, "gitChanges").mockResolvedValue(summary());
    const result = (text: string): import("../lib/ipc").FileDiff => ({
      path: "a.ts", text, isBinary: false, truncated: false, external: false,
    });
    const read = vi.spyOn(ipc, "gitFileDiff").mockResolvedValue(result("before"));
    try {
      await useChanges.getState().refreshGit(PROJ, "C:/repo");
      const file = { path: "a.ts", untracked: false };
      await fetchDiff(PROJ, "C:/repo", file, false);
      read.mockResolvedValue(result("after"));
      await useChanges.getState().refreshGit(PROJ, "C:/repo");
      expect((await fetchDiff(PROJ, "C:/repo", file, false)).text).toBe("after");
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Equal status and line counts do not imply equal file contents.
  it("refreshes a cached diff when text changes with unchanged line counts", async () => {
    reset();
    vi.useFakeTimers();
    const result = (text: string): import("../lib/ipc").FileDiff => ({
      path: "a.ts", text, isBinary: false, truncated: false, external: false,
    });
    vi.spyOn(ipc, "gitChanges").mockResolvedValue(summary());
    const read = vi.spyOn(ipc, "gitFileDiff").mockResolvedValue(result("old text"));
    try {
      await useChanges.getState().refreshGit(PROJ, "C:/repo");
      expect((await fetchDiff(PROJ, "C:/repo", { path: "a.ts", untracked: false }, false)).text)
        .toBe("old text");
      read.mockResolvedValue(result("new text"));
      useChanges.getState().applyActivity(activity([ev("a.ts", "modified", 1)]));
      await vi.advanceTimersByTimeAsync(1200);
      expect((await fetchDiff(PROJ, "C:/repo", { path: "a.ts", untracked: false }, false)).text)
        .toBe("new text");
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("a file that became staged counts as a new summary", async () => {
    useChanges.setState({
      watched: { [PROJ]: "C:\repo" },
      gitByProject: {},
      gitLoading: {},
    });
    const spy = vi.spyOn(ipc, "gitChanges").mockResolvedValue(summary());
    await useChanges.getState().refreshGit(PROJ, "C:\repo");
    expect(useChanges.getState().gitByProject[PROJ]?.files[0].index).toBe("none");

    // The same file, now staged AND touched again: `status`, path and counts
    // stay identical.
    spy.mockResolvedValue(summary({ index: "modified", staged: true }));
    await useChanges.getState().refreshGit(PROJ, "C:\repo");
    expect(useChanges.getState().gitByProject[PROJ]?.files[0].index).toBe("modified");
    spy.mockRestore();
  });

  it("a conflict whose pair changes is a new summary too", async () => {
    useChanges.setState({
      watched: { [PROJ]: "C:\repo" },
      gitByProject: {},
      gitLoading: {},
    });
    const spy = vi
      .spyOn(ipc, "gitChanges")
      .mockResolvedValue(summary({ status: "conflicted", conflict: "UU" }));
    await useChanges.getState().refreshGit(PROJ, "C:\repo");
    spy.mockResolvedValue(summary({ status: "conflicted", conflict: "DU" }));
    await useChanges.getState().refreshGit(PROJ, "C:\repo");
    expect(useChanges.getState().gitByProject[PROJ]?.files[0].conflict).toBe("DU");
    spy.mockRestore();
  });
});

/**
 * An open live diff tab re-reads with a `git` process of its own, so the
 * revision it follows may only move when something that can change *its* diff
 * happened. A single per-project counter used to re-read every open tab on
 * every batch the watcher sent, while an agent wrote anywhere in the project.
 */
describe("diffRevisionOf", () => {
  const ID = "revisions";
  const ROOT = "C:/repo";
  const revision = (path: string, origPath?: string | null) =>
    diffRevisionOf(useChanges.getState(), ID, path, origPath);
  const touch = (paths: string[], dropped = 0) =>
    useChanges.getState().applyActivity({
      projectId: ID,
      root: ROOT,
      events: paths.map((path, i) => ev(path, "modified", i)),
      dropped,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    useChanges.setState({ watched: { [ID]: ROOT } });
  });

  afterEach(() => {
    vi.spyOn(ipc, "unwatchProject").mockResolvedValue(undefined);
    useChanges.getState().dropProject(ID);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("moves only for the files an activity batch touched", () => {
    const a = revision("a.ts");
    const b = revision("src/b.ts");
    touch(["a.ts"]);
    expect(revision("a.ts")).not.toBe(a);
    expect(revision("src/b.ts")).toBe(b);
  });

  // A folder event (a move, a delete of the whole tree) names the folder only.
  it("moves for every file inside a folder the batch named", () => {
    const inside = revision("src/deep/b.ts");
    const beside = revision("srcx/c.ts");
    touch(["SRC\\"]);
    expect(revision("src/deep/b.ts")).not.toBe(inside);
    expect(revision("srcx/c.ts")).toBe(beside);
  });

  // The old side of a rename is read from the original name.
  it("moves for a rename when its original path is touched", () => {
    const renamed = revision("new.ts", "old.ts");
    touch(["old.ts"]);
    expect(revision("new.ts", "old.ts")).not.toBe(renamed);
  });

  // Past the watcher's window the batch cannot say what changed.
  it("moves for every file when a batch overflowed and lists no paths", () => {
    const untouched = revision("src/b.ts");
    touch(["a.ts"], 3);
    expect(revision("src/b.ts")).not.toBe(untouched);
  });

  const entry = (
    path: string,
    over: Partial<import("../lib/ipc").ChangedFile> = {},
  ): import("../lib/ipc").ChangedFile => ({
    path,
    origPath: null,
    status: "modified",
    staged: false,
    additions: 1,
    deletions: 0,
    binary: false,
    index: "none",
    worktree: "modified",
    conflict: null,
    ...over,
  });
  const status = (
    files: import("../lib/ipc").ChangedFile[],
    branch = "main",
  ): import("../lib/ipc").ChangesSummary => ({
    isRepo: true,
    branch,
    files,
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    uncounted: 0,
  });

  // While an agent writes, the totals change on nearly every `git status`.
  it("moves only for the files whose entry a new Git summary changed", async () => {
    const read = vi.spyOn(ipc, "gitChanges")
      .mockResolvedValue(status([entry("a.ts"), entry("src/b.ts")]));
    await useChanges.getState().refreshGit(ID, ROOT, false);
    const a = revision("a.ts");
    const b = revision("src/b.ts");
    read.mockResolvedValue(status([entry("a.ts", { additions: 7 }), entry("src/b.ts")]));
    await useChanges.getState().refreshGit(ID, ROOT, false);
    expect(revision("a.ts")).not.toBe(a);
    expect(revision("src/b.ts")).toBe(b);
  });

  // A checkout moves HEAD under every file, listed or not.
  it("moves for every file when the branch changes under equal entries", async () => {
    const read = vi.spyOn(ipc, "gitChanges").mockResolvedValue(status([entry("a.ts")]));
    await useChanges.getState().refreshGit(ID, ROOT, false);
    const unlisted = revision("src/b.ts");
    read.mockResolvedValue(status([entry("a.ts")], "feature"));
    await useChanges.getState().refreshGit(ID, ROOT, false);
    expect(revision("src/b.ts")).not.toBe(unlisted);
  });

  // A delete and an add that git starts reading as one rename.
  it("moves for both names when git pairs a delete and an add into a rename", async () => {
    const read = vi.spyOn(ipc, "gitChanges").mockResolvedValue(status([
      entry("old.ts", { status: "deleted", index: "deleted", worktree: "none", staged: true }),
      entry("new.ts", { status: "added", index: "added", worktree: "none", staged: true }),
    ]));
    await useChanges.getState().refreshGit(ID, ROOT, false);
    const before = { old: revision("old.ts"), renamed: revision("new.ts") };
    read.mockResolvedValue(status([
      entry("new.ts", {
        status: "renamed", origPath: "old.ts", index: "renamed", worktree: "none", staged: true,
      }),
    ]));
    await useChanges.getState().refreshGit(ID, ROOT, false);
    expect(revision("old.ts")).not.toBe(before.old);
    expect(revision("new.ts")).not.toBe(before.renamed);
  });

  // `git init` in a watched folder: nothing listed, and yet every diff changed.
  it("moves for every file when the folder becomes a repository", async () => {
    const read = vi.spyOn(ipc, "gitChanges")
      .mockResolvedValue({ ...status([]), isRepo: false, branch: null });
    await useChanges.getState().refreshGit(ID, ROOT, false);
    const before = revision("a.ts");
    read.mockResolvedValue({ ...status([]), branch: null });
    await useChanges.getState().refreshGit(ID, ROOT, false);
    expect(revision("a.ts")).not.toBe(before);
  });
});
