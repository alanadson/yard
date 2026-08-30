/**
 * What this operation wrote, in the order it wrote it.
 *
 * A creation that dies halfway has already put things on the disk, and the
 * disk cannot be asked which of them are ours: a folder at
 * `.yard/floors/login` may be the one this batch made a second ago or one
 * that has been there since last week with a day's work in it. Nothing about
 * the folder itself tells them apart, and deleting the wrong one cannot be
 * undone.
 *
 * So the rule is the strict one from §14: **an operation may clean up only
 * what it recorded as its own.** The journal is that record — written as
 * `planned` before the effect, stamped `applied` after it, which is what
 * makes a crash *between* the two survivable: an entry stuck on `planned` is
 * a maybe, and a maybe is never deleted.
 *
 * Pure and immutable, so the whole runner can be replayed in a test.
 */

export type Effect =
  | "branch_created"
  | "worktree_created"
  | "group_registered"
  | "setup_started"
  | "agent_started";

export type EntryState = "planned" | "applied" | "compensated" | "compensation_failed";

export interface JournalEntry {
  itemId: string;
  effect: Effect;
  /** The path, the branch, the group id, the terminal id — whatever it made. */
  resourceId: string;
  /**
   * Where a created branch was born. The rollback deletes it only while it is
   * still there; the moment an agent commits, this stops matching and the
   * branch is kept.
   */
  expectedOid?: string;
  state: EntryState;
}

export interface Journal {
  entries: readonly JournalEntry[];
}

export function empty(): Journal {
  return { entries: [] };
}

export function record(
  journal: Journal,
  entry: Omit<JournalEntry, "state">,
): Journal {
  return { entries: [...journal.entries, { ...entry, state: "planned" }] };
}

/** Marks the last entry for that item and effect. */
export function stamp(
  journal: Journal,
  itemId: string,
  effect: Effect,
  state: EntryState,
): Journal {
  let last = -1;
  journal.entries.forEach((e, i) => {
    if (e.itemId === itemId && e.effect === effect) last = i;
  });
  if (last < 0) return journal;
  const entries = [...journal.entries];
  entries[last] = { ...entries[last], state };
  return { entries };
}

/**
 * What to undo for one item, in the order to undo it: the agent before the
 * group, the group before the worktree, the worktree before the branch.
 *
 * Only `applied` entries. A `planned` one may or may not have happened and is
 * left for the reconciler and a human; a `compensated` one is already gone,
 * and offering it twice is how a retry deletes something it did not make.
 */
export function compensationsFor(journal: Journal, itemId: string): JournalEntry[] {
  return journal.entries
    .filter((e) => e.itemId === itemId && e.state === "applied")
    .reverse();
}

/**
 * The same walk, for a cleanup asked for **by hand**.
 *
 * It includes what refused to go the first time. The automatic rollback
 * leaves those alone on purpose — a step that failed once is not worth
 * hammering, and a person has to be told — but once that person presses
 * "tentar limpar de novo", the entry that failed is exactly the one they mean.
 */
export function retryCompensationsFor(journal: Journal, itemId: string): JournalEntry[] {
  return journal.entries
    .filter(
      (e) =>
        e.itemId === itemId &&
        (e.state === "applied" || e.state === "compensation_failed"),
    )
    .reverse();
}

/** Everything still standing, for the "limpar" screen. */
export function pending(journal: Journal): JournalEntry[] {
  return journal.entries.filter((e) => e.state === "applied");
}
