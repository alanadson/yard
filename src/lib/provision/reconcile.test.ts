/**
 * What the app believes about its fronts, against what git and the disk say.
 *
 * Everything a batch writes is written outside the app: a folder, a branch, a
 * `worktree` entry in `.git`. So the two can drift, and every way they drift
 * is invisible on screen. A front whose folder somebody deleted from Explorer
 * still shows a name, a branch and a tab bar; a worktree the app crashed
 * halfway through creating is on the disk with nothing pointing at it.
 *
 * The rule that shapes this whole module: **it decides, it does not act.** It
 * says a folder is gone; it does not `prune`. It says a worktree has no front;
 * it does not adopt one. Deleting on a guess is the one mistake here that
 * cannot be undone, and "the folder looks like ours" is a guess.
 */
import { describe, expect, it } from "vitest";

import { reconcile, type FrontRecord } from "./reconcile";
import type { WorktreeEntry } from "../ipc";

const GROUND = "C:/proj";

const front = (over: Partial<FrontRecord> & { groupId: string }): FrontRecord => ({
  name: "login",
  path: "C:/proj/.yard/floors/login",
  adopted: false,
  ...over,
});

const wt = (path: string, branch: string | null = "yard/login"): WorktreeEntry => ({
  path,
  branch,
  bare: false,
});

const run = (
  fronts: FrontRecord[],
  worktrees: WorktreeEntry[],
  exists: Record<string, boolean>,
) => reconcile({ groundPath: GROUND, fronts, worktrees, exists });

describe("a front that is exactly where it says it is", () => {
  it("is healthy, and nothing is recommended about it", () => {
    const r = run(
      [front({ groupId: "g1" })],
      [wt(GROUND, "main"), wt("C:/proj/.yard/floors/login")],
      { "C:/proj/.yard/floors/login": true },
    );
    expect(r.fronts).toEqual([
      expect.objectContaining({ groupId: "g1", health: "ok" }),
    ]);
    expect(r.unregistered).toEqual([]);
    expect(r.prunable).toEqual([]);
  });

  it("matches whatever slashes and case the two sides happen to use", () => {
    const r = run(
      [front({ groupId: "g1", path: "C:\\proj\\.yard\\floors\\Login\\" })],
      [wt(GROUND, "main"), wt("c:/proj/.yard/floors/login")],
      { "C:\\proj\\.yard\\floors\\Login\\": true },
    );
    expect(r.fronts[0].health).toBe("ok");
  });
});

describe("a front whose folder is gone", () => {
  /**
   * Deleted from Explorer, or on a drive that is not mounted today. Either
   * way the front is a name with nothing behind it, and the tab bar still
   * offers to open a terminal there.
   */
  it("is orphaned, and its git entry is listed as prunable, not pruned", () => {
    const r = run(
      [front({ groupId: "g1" })],
      [wt(GROUND, "main"), wt("C:/proj/.yard/floors/login")],
      { "C:/proj/.yard/floors/login": false },
    );
    expect(r.fronts[0].health).toBe("orphaned");
    expect(r.prunable).toEqual(["C:/proj/.yard/floors/login"]);
  });

  it("is orphaned even when git has already forgotten it", () => {
    const r = run([front({ groupId: "g1" })], [wt(GROUND, "main")], {
      "C:/proj/.yard/floors/login": false,
    });
    expect(r.fronts[0].health).toBe("orphaned");
    // Nothing for git to prune: the entry is not there either.
    expect(r.prunable).toEqual([]);
  });
});

describe("a front git no longer lists", () => {
  /**
   * The folder is right there with the work in it, and `git worktree list`
   * does not mention it: a repository moved, a `.git` file rewritten, a
   * `prune` that ran while the drive was unplugged. `git worktree repair` is
   * the answer, and it is one a person has to ask for.
   */
  it("needs repair, and is never confused with a front that vanished", () => {
    const r = run([front({ groupId: "g1" })], [wt(GROUND, "main")], {
      "C:/proj/.yard/floors/login": true,
    });
    expect(r.fronts[0].health).toBe("repair_required");
  });
});

describe("a worktree on the disk that no front opened", () => {
  it("is reported so it can be adopted, and never adopted automatically", () => {
    const r = run([], [wt(GROUND, "main"), wt("D:/tmp/hotfix", "hotfix")], {
      "D:/tmp/hotfix": true,
    });
    expect(r.unregistered).toEqual([{ path: "D:/tmp/hotfix", branch: "hotfix" }]);
  });

  it("does not count the ground: the project's own checkout is not a loose worktree", () => {
    const r = run([], [wt(GROUND, "main")], {});
    expect(r.unregistered).toEqual([]);
  });

  it("does not count a bare repository, which has no working copy to open", () => {
    const r = run([], [wt(GROUND, "main"), { path: "D:/mirror", branch: null, bare: true }], {
      "D:/mirror": true,
    });
    expect(r.unregistered).toEqual([]);
  });

  it("does not count one whose folder is gone: that is a prune, not an adoption", () => {
    const r = run([], [wt(GROUND, "main"), wt("D:/tmp/hotfix", "hotfix")], {
      "D:/tmp/hotfix": false,
    });
    expect(r.unregistered).toEqual([]);
    expect(r.prunable).toEqual(["D:/tmp/hotfix"]);
  });
});

describe("what needs a person", () => {
  it("is nothing at all when every front is where it should be", () => {
    const r = run(
      [front({ groupId: "g1" })],
      [wt(GROUND, "main"), wt("C:/proj/.yard/floors/login")],
      { "C:/proj/.yard/floors/login": true },
    );
    expect(r.needsAttention).toBe(false);
  });

  /**
   * An unregistered worktree is worth *saying* and is not a problem: somebody
   * made it with git, on purpose, and the Yard has no opinion about that.
   * Raising it to the same level as a front with no folder would teach people
   * to dismiss the warning that matters.
   */
  it("is not a loose worktree on its own", () => {
    const r = run([], [wt(GROUND, "main"), wt("D:/tmp/hotfix", "hotfix")], {
      "D:/tmp/hotfix": true,
    });
    expect(r.needsAttention).toBe(false);
  });

  it("is any front that lost its folder or its git entry", () => {
    const r = run([front({ groupId: "g1" })], [wt(GROUND, "main")], {
      "C:/proj/.yard/floors/login": true,
    });
    expect(r.needsAttention).toBe(true);
  });
});

describe("the sentence the reconciliation is worth", () => {
  it("says nothing when there is nothing to say", () => {
    const r = run(
      [front({ groupId: "g1" })],
      [wt(GROUND, "main"), wt("C:/proj/.yard/floors/login")],
      { "C:/proj/.yard/floors/login": true },
    );
    expect(r.summary).toBe("");
  });

  it("names the fronts, because a count with no names sends nobody anywhere", () => {
    const r = run(
      [front({ groupId: "g1" }), front({ groupId: "g2", name: "auth", path: "C:/proj/.yard/floors/auth" })],
      [wt(GROUND, "main")],
      { "C:/proj/.yard/floors/login": true, "C:/proj/.yard/floors/auth": false },
    );
    expect(r.summary).toContain("login");
    expect(r.summary).toContain("auth");
  });
});

/**
 * A project on a drive that is not plugged in today. Every front of it looks
 * orphaned and none of them is: the whole checkout is simply not there. A
 * reconciliation that shouted about it would train people to dismiss the one
 * that matters, and the recommended action would be wrong anyway.
 */
describe("a project whose own folder is not there", () => {
  it("is not reconciled at all: nothing is judged, nothing is recommended", () => {
    const r = run(
      [front({ groupId: "g1" })],
      [],
      { [GROUND]: false, "C:/proj/.yard/floors/login": false },
    );
    expect(r.fronts.every((f) => f.health === "ok")).toBe(true);
    expect(r.needsAttention).toBe(false);
    expect(r.prunable).toEqual([]);
    expect(r.summary).toBe("");
  });

  it("still reconciles when the ground was never asked about", () => {
    // The caller only looked up the paths it cared about; absence of an entry
    // for the ground is not a claim that the ground is missing.
    const r = run([front({ groupId: "g1" })], [], { "C:/proj/.yard/floors/login": false });
    expect(r.fronts[0].health).toBe("orphaned");
  });
});
