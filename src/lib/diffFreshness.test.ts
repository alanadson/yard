/**
 * What an open diff tab subscribes to in the `git status` summary.
 *
 * The tab re-reads with a `git` process of its own every time its
 * subscription changes. Subscribing to the whole summary object re-read every
 * open tab whenever any file of the project changed status or line counts,
 * which, while an agent writes, is nearly every read. The signature has to
 * move for this file's own entry (both sides, the conflict pair, a rename
 * pairing) and stay still for everyone else's.
 */
import { describe, expect, it } from "vitest";

import { contentRevisionOf, entrySignature, markContentChanged } from "./diffFreshness";
import type { ChangedFile, ChangesSummary } from "./ipc";

function entry(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return {
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
  };
}

function status(files: ChangedFile[]): ChangesSummary {
  return { isRepo: true, branch: "main", files, additions: 0, deletions: 0, uncounted: 0 };
}

describe("entrySignature", () => {
  it("changes when the file is staged even though status and counts stay equal", () => {
    const before = status([entry("a.ts")]);
    const after = status([entry("a.ts", { index: "modified", staged: true })]);
    expect(entrySignature(after, "a.ts")).not.toBe(entrySignature(before, "a.ts"));
  });

  it("stays equal when only another file's entry changes", () => {
    const before = status([entry("a.ts"), entry("src/b.ts")]);
    const after = status([entry("a.ts", { additions: 9 }), entry("src/b.ts")]);
    expect(entrySignature(after, "src/b.ts")).toBe(entrySignature(before, "src/b.ts"));
  });

  // The old side of a rename is read from the original name.
  it("follows the entry of the name a rename came from", () => {
    const renamed = entry("new.ts", { status: "renamed", origPath: "old.ts" });
    const before = status([renamed]);
    const after = status([renamed, entry("old.ts", { status: "untracked" })]);
    expect(entrySignature(after, "new.ts", "old.ts"))
      .not.toBe(entrySignature(before, "new.ts", "old.ts"));
  });
});

/**
 * The per-path ticks grow with every distinct path an agent touches in a
 * session. Past the cap they are forgotten, and forgetting must never let an
 * open diff miss a change: every file moves instead.
 */
describe("markContentChanged", () => {
  it("past its cap forgets the per-path ticks and moves every file instead", () => {
    const first = markContentChanged(undefined, 1, ["a.ts", "b.ts"], 2);
    const untouched = contentRevisionOf(first, "z.ts");
    const touched = contentRevisionOf(first, "a.ts");
    const next = markContentChanged(first, 2, ["c.ts"], 2);
    expect(Object.keys(next.byPath).length).toBeLessThanOrEqual(2);
    expect(contentRevisionOf(next, "z.ts")).not.toBe(untouched);
    expect(contentRevisionOf(next, "a.ts")).not.toBe(touched);
  });
});
