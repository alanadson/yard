/**
 * Running a plan: the part that writes.
 *
 * Everything it needs was decided in `plan.ts`; what is left is the order, the
 * bookkeeping and what happens when the fifth of six steps fails with the
 * first four already on the disk. That last one is the whole reason this file
 * exists — the old dialog's answer to it was a `catch` that showed git's
 * error and left whatever had been created lying around, unnamed, for
 * somebody to find with `git worktree list` a week later.
 *
 * Four rules, and they are not negotiable:
 *
 * 1. **Rows run one at a time.** They are all in one repository, and git
 *    serialises `worktree add` anyway — badly, with a lock error instead of a
 *    queue. Two rows in flight buy nothing and lose the ordering.
 * 2. **An operation undoes only what it wrote**, read back from its own
 *    journal. Never "the folder at that path": it may be a week old.
 * 3. **A branch that moved is never deleted.** An agent committed to it and
 *    that work exists nowhere else. The row ends in `cleanup_required`, with
 *    a sentence, instead of ending in silence.
 * 4. **An agent that fails to start does not take its front down.** The
 *    worktree is built, the group is registered, and pressing the button
 *    again has to reuse them, not build them a second time.
 *
 * The effects come in as an interface, which is what lets every rule above be
 * tested with no git, no disk and no clock.
 */
import type { Preflight } from "../ipc";
import { issue, type ProvisionIssue } from "./errors";
import {
  compensationsFor,
  empty as emptyJournal,
  record,
  retryCompensationsFor,
  stamp,
  type Journal,
} from "./journal";
import { planIsStale, worldFingerprint, type Plan, type PlannedItem } from "./plan";

/** What the screen says it is doing. Portuguese, drawn through `t()`. */
export type Phase =
  | "esperando"
  | "validando"
  | "criando"
  | "registrando"
  | "setup"
  | "iniciando"
  | "pronto";

export type ItemState =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "cancelled"
  | "rolled_back"
  /** Something this operation made could not be undone, and a hand is needed. */
  | "cleanup_required";

export type BatchState =
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "cancelled"
  | "cleanup_required";

/** What to do with the rows that come *after* one has failed. */
export type FailurePolicy = "continue" | "stop_pending" | "compensate_created";

/** What to do about the row's setup commands. */
export type SetupPolicy = "wait_for_setup" | "run_parallel" | "skip";

export interface ItemReport {
  clientItemId: string;
  displayName: string;
  state: ItemState;
  phase: Phase;
  /** Why it stopped, when it stopped. */
  issue: ProvisionIssue | null;
  warnings: ProvisionIssue[];
  groupId: string | null;
  path: string | null;
  branch: string | null;
}

export interface BatchReport {
  state: BatchState;
  items: ItemReport[];
  journal: Journal;
}

/** Where a row's front ended up, for the caller that registers the group. */
export interface Provisioned {
  path: string;
  branch: string | null;
  headOid: string | null;
}

/**
 * The boundary. Everything below this line touches git, the store or a
 * process; everything above it is the rules, and the rules are what is
 * tested.
 */
export interface ProvisionEffects {
  /** Reads the repository again, right before the first write. */
  refresh(): Promise<Preflight>;
  createWorktree(item: PlannedItem): Promise<Provisioned>;
  registerGroup(item: PlannedItem, at: Provisioned): Promise<string>;
  runSetup(item: PlannedItem, groupId: string, at: Provisioned): Promise<void>;
  /** The terminal id, or `null` when the row asked for no agent. */
  launchAgent(item: PlannedItem, groupId: string, at: Provisioned): Promise<string | null>;
  removeWorktree(path: string): Promise<void>;
  /** `false` = the branch moved and was kept. */
  deleteBranch(branch: string, expectedOid: string): Promise<boolean>;
  dropGroup(groupId: string): Promise<void>;
  stopAgent(terminalId: string): Promise<void>;
}

export interface RunBatchInput {
  plan: Plan;
  effects: ProvisionEffects;
  policy?: FailurePolicy;
  setupPolicy?: SetupPolicy;
  /** The clock, as an argument — a rule with a `Date.now()` in it is untestable. */
  now: () => number;
  /** The cancel button, read between rows. */
  cancelled?: () => boolean;
  /** Only these rows run; the rest come back `cancelled`. This is the retry. */
  only?: readonly string[];
  onProgress?: (report: BatchReport) => void;
}

const detailOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runBatch(input: RunBatchInput): Promise<BatchReport> {
  const { plan, effects } = input;
  const policy = input.policy ?? "continue";
  const setupPolicy = input.setupPolicy ?? "wait_for_setup";

  const reports = new Map<string, ItemReport>(
    plan.items.map((i) => [
      i.clientItemId,
      {
        clientItemId: i.clientItemId,
        displayName: i.displayName,
        state: "pending" as ItemState,
        phase: "esperando" as Phase,
        issue: null,
        warnings: [...i.warnings],
        groupId: null,
        path: null,
        branch: null,
      },
    ]),
  );
  let journal = emptyJournal();
  /** Rows that finished, newest last — what `compensate_created` walks back. */
  const done: string[] = [];

  const snapshot = (): BatchReport => ({
    state: "failed",
    items: plan.items.map((i) => ({ ...reports.get(i.clientItemId)! })),
    journal,
  });
  const emit = () => input.onProgress?.(snapshot());
  const set = (id: string, patch: Partial<ItemReport>) => {
    reports.set(id, { ...reports.get(id)!, ...patch });
    emit();
  };

  const stopEverything = (why: ProvisionIssue) => {
    for (const item of plan.items) {
      set(item.clientItemId, { state: "failed", phase: "validando", issue: why });
    }
    return { ...snapshot(), state: "failed" as BatchState };
  };

  // --- before anything is written ------------------------------------------
  // The plan is a photograph. Two things can have happened since it was
  // taken: enough time (it expired) or enough change (the fingerprint moved).
  // Either way nothing is created on a base nobody approved.
  if (planIsStale(plan, input.now())) return stopEverything(issue("PLAN_STALE"));
  const fresh = await effects.refresh();
  if (worldFingerprint(fresh) !== plan.fingerprint) return stopEverything(issue("PLAN_STALE"));

  // --- one row at a time ---------------------------------------------------
  let stopped = false;
  for (const item of plan.items) {
    const id = item.clientItemId;
    const skipped = input.only && !input.only.includes(id);
    if (stopped || skipped || input.cancelled?.()) {
      set(id, { state: "cancelled", phase: "esperando" });
      continue;
    }
    if (item.errors.length) {
      // A row the plan already blocked. It can only get here through a retry
      // of a plan that was never valid — the button is what normally stops it.
      set(id, { state: "failed", phase: "validando", issue: item.errors[0] });
      if (policy === "stop_pending") stopped = true;
      continue;
    }

    set(id, { state: "running", phase: "criando" });
    let at: Provisioned;
    try {
      if (item.action === "create_worktree") {
        // Written down *before* the effect: a crash between these two lines
        // leaves a `planned` entry, and a `planned` entry is a maybe — the
        // reconciler shows it to a person and nothing is deleted on a guess.
        if (item.base) {
          journal = record(journal, {
            itemId: id,
            effect: "branch_created",
            resourceId: item.branch ?? "",
            expectedOid: item.base.oid,
          });
        }
        journal = record(journal, {
          itemId: id,
          effect: "worktree_created",
          resourceId: item.path,
        });
        at = await effects.createWorktree(item);
        journal = stamp(journal, id, "worktree_created", "applied");
        if (item.base) {
          // The OID to compare against on rollback is the one the worktree
          // was actually born at, not the one the plan hoped for.
          journal = stamp(journal, id, "branch_created", "applied");
          journal = {
            entries: journal.entries.map((e) =>
              e.itemId === id && e.effect === "branch_created"
                ? { ...e, expectedOid: at.headOid ?? e.expectedOid, resourceId: at.branch ?? e.resourceId }
                : e,
            ),
          };
        }
      } else {
        // Adopting, using the ground, or a project with no git: the folder is
        // already there. Nothing goes in the journal, so nothing here can
        // ever be removed by a rollback.
        at = { path: item.path, branch: item.branch, headOid: null };
      }
      set(id, { path: at.path, branch: at.branch });
    } catch (e) {
      set(id, { issue: issue("PROVISION_FAILED", { detail: detailOf(e) }) });
      await compensate(id);
      if (policy === "stop_pending") stopped = true;
      if (policy === "compensate_created") stopped = await compensateEverything();
      continue;
    }

    try {
      set(id, { phase: "registrando" });
      const groupId = await effects.registerGroup(item, at);
      journal = record(journal, { itemId: id, effect: "group_registered", resourceId: groupId });
      journal = stamp(journal, id, "group_registered", "applied");
      set(id, { groupId });

      if (setupPolicy !== "skip") {
        set(id, { phase: "setup" });
        try {
          journal = record(journal, { itemId: id, effect: "setup_started", resourceId: groupId });
          await effects.runSetup(item, groupId, at);
          journal = stamp(journal, id, "setup_started", "applied");
        } catch (e) {
          const failed = issue("SETUP_FAILED", { detail: detailOf(e) });
          if (setupPolicy === "wait_for_setup") {
            // The front stays: it is built, and the person can fix the setup
            // and press the button again without paying for it twice.
            set(id, { state: "failed", phase: "setup", issue: failed });
            done.push(id);
            if (policy === "stop_pending") stopped = true;
            continue;
          }
          set(id, { warnings: [...reports.get(id)!.warnings, failed] });
        }
      }

      set(id, { phase: "iniciando" });
      const terminalId = await effects.launchAgent(item, groupId, at);
      if (terminalId) {
        journal = record(journal, { itemId: id, effect: "agent_started", resourceId: terminalId });
        journal = stamp(journal, id, "agent_started", "applied");
      }
      set(id, { state: "ready", phase: "pronto" });
      done.push(id);
    } catch (e) {
      const isLaunch = reports.get(id)!.phase === "iniciando";
      if (isLaunch) {
        // Rule 4: the front is standing and must not be rebuilt. Nothing is
        // compensated here — the retry reuses it.
        set(id, { state: "failed", issue: issue("AGENT_LAUNCH_FAILED", { detail: detailOf(e) }) });
        done.push(id);
      } else {
        set(id, { issue: issue("PROVISION_FAILED", { detail: detailOf(e) }) });
        await compensate(id);
      }
      if (policy === "stop_pending") stopped = true;
      if (policy === "compensate_created" && !isLaunch) stopped = await compensateEverything();
    }
  }

  return { ...snapshot(), state: batchStateOf([...reports.values()]) };

  /** Undoes one row and writes the outcome onto its report. */
  async function compensate(id: string): Promise<void> {
    const r = await compensateItem(journal, id, effects);
    journal = r.journal;
    set(id, { state: r.state, ...(r.issue ? { issue: r.issue } : {}) });
  }

  /** `compensate_created`: walk the rows that had worked, last one first. */
  async function compensateEverything(): Promise<boolean> {
    for (const id of [...done].reverse()) {
      await compensate(id);
    }
    done.length = 0;
    return true;
  }
}

/**
 * Undoing one row, newest effect first, reading only its own journal.
 *
 * Shared by the automatic rollback and the "tentar limpar de novo" button, so
 * the guarantees cannot drift apart: the same walk, the same order, the same
 * refusal to delete a branch that moved.
 *
 * A step that refuses stops the walk. Deleting the branch of a worktree still
 * standing would leave git in a state neither the app nor the person can read
 * — the folder is there, its branch is gone, and `git worktree list` starts
 * answering nonsense.
 */
export interface CompensationResult {
  journal: Journal;
  state: "rolled_back" | "cleanup_required";
  issue: ProvisionIssue | null;
}

export async function compensateItem(
  journal: Journal,
  itemId: string,
  effects: ProvisionEffects,
  opts: { byHand?: boolean } = {},
): Promise<CompensationResult> {
  const entries = opts.byHand
    ? retryCompensationsFor(journal, itemId)
    : compensationsFor(journal, itemId);
  let next = journal;
  for (const entry of entries) {
    try {
      switch (entry.effect) {
        case "agent_started":
          await effects.stopAgent(entry.resourceId);
          break;
        case "setup_started":
          // A command that already ran cannot be un-run. It is stamped so the
          // walk does not offer it again, and that is all.
          break;
        case "group_registered":
          await effects.dropGroup(entry.resourceId);
          break;
        case "worktree_created":
          await effects.removeWorktree(entry.resourceId);
          break;
        case "branch_created": {
          const gone = await effects.deleteBranch(entry.resourceId, entry.expectedOid ?? "");
          if (!gone) {
            // The branch has work on it. It stays, and the row says so.
            next = stamp(next, itemId, entry.effect, "compensation_failed");
            return {
              journal: next,
              state: "cleanup_required",
              issue: issue("ROLLBACK_INCOMPLETE", {
                detail: `a branch ${entry.resourceId} recebeu trabalho e foi mantida`,
              }),
            };
          }
          break;
        }
      }
      next = stamp(next, itemId, entry.effect, "compensated");
    } catch (e) {
      next = stamp(next, itemId, entry.effect, "compensation_failed");
      return {
        journal: next,
        state: "cleanup_required",
        issue: issue("ROLLBACK_INCOMPLETE", { detail: detailOf(e) }),
      };
    }
  }
  return { journal: next, state: "rolled_back", issue: null };
}

export interface CleanupReport {
  journal: Journal;
  items: { clientItemId: string; state: ItemState; issue: ProvisionIssue | null }[];
}

/**
 * The "limpar" button of the progress screen: walks the rows the person
 * picked, including the steps that refused the first time.
 */
export async function cleanupItems(
  journal: Journal,
  itemIds: readonly string[],
  effects: ProvisionEffects,
): Promise<CleanupReport> {
  let next = journal;
  const items: CleanupReport["items"] = [];
  for (const id of itemIds) {
    const r = await compensateItem(next, id, effects, { byHand: true });
    next = r.journal;
    items.push({ clientItemId: id, state: r.state, issue: r.issue });
  }
  return { journal: next, items };
}

/**
 * One word for the whole batch. `cleanup_required` wins over everything: it
 * is the only state that needs a person, and burying it under "parcialmente
 * concluído" is how a leftover worktree goes unnoticed for a week.
 */
export function batchStateOf(items: readonly ItemReport[]): BatchState {
  if (items.some((i) => i.state === "cleanup_required")) return "cleanup_required";
  const ready = items.filter((i) => i.state === "ready").length;
  const failed = items.filter((i) => i.state === "failed" || i.state === "rolled_back").length;
  if (ready === items.length) return "succeeded";
  if (ready > 0) return "partially_succeeded";
  if (failed > 0) return "failed";
  return "cancelled";
}
