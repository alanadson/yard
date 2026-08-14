/**
 * The live feed reducer.
 *
 * Order is the contract here: the panel renders the array as it comes, so
 * "most recently touched at the top" has to survive a batch that re-touches
 * paths already in the list. The dedup rule matters too — a file created and
 * then modified in the same session is still *new*, and the badge must say so.
 */
import { describe, expect, it } from "vitest";

import { useChanges } from "./changesStore";
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
  useChanges.setState({ liveByProject: {}, droppedByProject: {} });
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
});
