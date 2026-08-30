/**
 * A creation that fails halfway has already written things. Which things is
 * not something you can ask the disk afterwards: a folder in
 * `.yard/floors/login` may be the one this batch just made, or one that was
 * there since last week — and deleting the wrong one is unrecoverable.
 *
 * So every effect is written down *before* it happens and stamped when it
 * lands. The journal is that list, and it is the only thing the rollback is
 * allowed to read: an operation cleans up what it recorded, and nothing else.
 */
import { describe, expect, it } from "vitest";

import { compensationsFor, empty, record, retryCompensationsFor, stamp } from "./journal";

describe("the journal of what an operation wrote", () => {
  it("starts empty and appends without touching what is already in it", () => {
    const a = empty();
    const b = record(a, { itemId: "1", effect: "worktree_created", resourceId: "C:/w/a" });
    expect(a.entries).toHaveLength(0);
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0].state).toBe("planned");
  });

  it("an effect only counts as done once it is stamped — the crash in between is the point", () => {
    let j = record(empty(), { itemId: "1", effect: "worktree_created", resourceId: "C:/w/a" });
    expect(compensationsFor(j, "1")).toEqual([]);
    j = stamp(j, "1", "worktree_created", "applied");
    expect(compensationsFor(j, "1").map((e) => e.effect)).toEqual(["worktree_created"]);
  });

  it("undoes in reverse: the agent first, the branch last", () => {
    let j = empty();
    for (const [effect, resourceId] of [
      ["branch_created", "yard/login"],
      ["worktree_created", "C:/w/a"],
      ["group_registered", "g1"],
      ["agent_started", "t1"],
    ] as const) {
      j = record(j, { itemId: "1", effect, resourceId });
      j = stamp(j, "1", effect, "applied");
    }
    expect(compensationsFor(j, "1").map((e) => e.effect)).toEqual([
      "agent_started",
      "group_registered",
      "worktree_created",
      "branch_created",
    ]);
  });

  it("never hands one item's effects to another item's rollback", () => {
    let j = record(empty(), { itemId: "1", effect: "worktree_created", resourceId: "C:/w/a" });
    j = stamp(j, "1", "worktree_created", "applied");
    j = record(j, { itemId: "2", effect: "worktree_created", resourceId: "C:/w/b" });
    j = stamp(j, "2", "worktree_created", "applied");
    expect(compensationsFor(j, "1").map((e) => e.resourceId)).toEqual(["C:/w/a"]);
  });

  it("stops offering an effect once it has been compensated, so a retry does not undo it twice", () => {
    let j = record(empty(), { itemId: "1", effect: "worktree_created", resourceId: "C:/w/a" });
    j = stamp(j, "1", "worktree_created", "applied");
    j = stamp(j, "1", "worktree_created", "compensated");
    expect(compensationsFor(j, "1")).toEqual([]);
  });

  it("keeps a failed compensation on the list — that is what `cleanup_required` is made of", () => {
    let j = record(empty(), { itemId: "1", effect: "worktree_created", resourceId: "C:/w/a" });
    j = stamp(j, "1", "worktree_created", "applied");
    j = stamp(j, "1", "worktree_created", "compensation_failed");
    expect(j.entries[0].state).toBe("compensation_failed");
    // It is not offered again automatically: a hand has to be involved.
    expect(compensationsFor(j, "1")).toEqual([]);
  });

  it("carries the commit a created branch was born at, which is the whole safety of deleting it", () => {
    const j = record(empty(), {
      itemId: "1",
      effect: "branch_created",
      resourceId: "yard/login",
      expectedOid: "abc",
    });
    expect(j.entries[0].expectedOid).toBe("abc");
  });
});

describe("asking for a cleanup a second time", () => {
  it("offers back exactly what refused to go, and nothing that already went", () => {
    let j = record(empty(), { itemId: "1", effect: "branch_created", resourceId: "yard/a" });
    j = stamp(j, "1", "branch_created", "applied");
    j = record(j, { itemId: "1", effect: "worktree_created", resourceId: "C:/w/a" });
    j = stamp(j, "1", "worktree_created", "applied");
    j = stamp(j, "1", "worktree_created", "compensation_failed");
    // The branch is still `applied` (the walk stopped before it) and the
    // worktree is the one that refused: both are on the table again.
    expect(retryCompensationsFor(j, "1").map((e) => e.effect)).toEqual([
      "worktree_created",
      "branch_created",
    ]);
    j = stamp(j, "1", "worktree_created", "compensated");
    expect(retryCompensationsFor(j, "1").map((e) => e.effect)).toEqual(["branch_created"]);
  });
});
