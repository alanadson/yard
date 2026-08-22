/**
 * The live feed reducer.
 *
 * Order is the contract here: the panel renders the array as it comes, so
 * "most recently touched at the top" has to survive a batch that re-touches
 * paths already in the list. The dedup rule matters too — a file created and
 * then modified in the same session is still *new*, and the badge must say so.
 */
import { describe, expect, it, vi } from "vitest";

import { useChanges } from "./changesStore";
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
