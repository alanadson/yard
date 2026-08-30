/**
 * The dialog's own rules, out of the JSX.
 *
 * What lives here is everything that has a right and a wrong answer: how a
 * matrix of rows gets named from one pattern without two of them colliding,
 * what a duplicate keeps and what it must clear, which warnings are worth
 * holding the button for, and what the line under the button actually counts.
 *
 * None of it needs React, and that is the test: a rule you cannot describe
 * without a component is a rule nobody can check.
 */
import type { WorktreeEntry } from "../../lib/ipc";
import { rootKey } from "../../lib/roots";
import { expandPattern, uniqueIn } from "../../lib/provision/naming";
import type { ItemReport } from "../../lib/provision/batch";
import type { ProvisionIssue } from "../../lib/provision/errors";
import type { BranchChoice, BranchWhere } from "../../lib/destination";
import type { Plan, TargetKind, TargetSpec } from "../../lib/provision/plan";

/** One row of the dialog, as the person left it. Empty means "you decide". */
export interface FrontRow {
  id: string;
  kind: TargetKind;
  name: string;
  branch: string;
  worktreeName: string;
  baseRef: string;
  worktreePath: string;
  agentId: string | null;
  prompt: string;
}

export function newRow(id: string, over: Partial<FrontRow> = {}): FrontRow {
  return {
    id,
    // The common case, and the only one that needs nothing chosen first.
    kind: "new_worktree_new_branch",
    name: "",
    // These three stay empty on purpose: empty is what tells the backend to
    // derive them, and a derived value is one it is allowed to make unique.
    branch: "",
    worktreeName: "",
    baseRef: "",
    worktreePath: "",
    agentId: null,
    prompt: "",
    ...over,
  };
}

/**
 * The worktrees "Worktree existente" is allowed to offer.
 *
 * Three exclusions, and each one is a promise the destination could not keep:
 * the ground is the copy the user already has open (that is "Workspace
 * atual", not an adoption); a bare repository has no working copy to open;
 * and a worktree another front already works in cannot take a second one,
 * because closing either front would take the files out from under the other.
 *
 * The count matters as much as the list. When it is zero the destination has
 * nothing to offer, and offering it anyway is what put an empty picker on
 * screen with two refusals under it and no way forward.
 */
export function adoptableWorktrees(
  worktrees: readonly WorktreeEntry[],
  opts: { groundPath: string; ownedPaths: readonly string[] },
): WorktreeEntry[] {
  const ground = rootKey(opts.groundPath);
  const owned = new Set(opts.ownedPaths.map(rootKey));
  return worktrees.filter((w) => {
    const key = rootKey(w.path);
    return !w.bare && key !== ground && !owned.has(key);
  });
}

export type DestinationChoice = "new_worktree" | "existing_worktree" | "current_workspace";

/**
 * Moves one draft between the three destinations the person understands.
 * Fields that only had meaning in the old destination are cleared so a later
 * plan cannot accidentally revive an old branch or base.
 */
export function selectDestination(row: FrontRow, choice: DestinationChoice): FrontRow {
  if (choice === "new_worktree") {
    return {
      ...row,
      kind:
        row.kind === "new_worktree_existing_branch"
          ? "new_worktree_existing_branch"
          : "new_worktree_new_branch",
      worktreePath: "",
    };
  }
  if (choice === "existing_worktree") {
    return {
      ...row,
      kind: "existing_worktree",
      branch: "",
      worktreeName: "",
      baseRef: "",
    };
  }
  return {
    ...row,
    kind: "current_workspace",
    branch: "",
    worktreeName: "",
    baseRef: "",
    worktreePath: "",
  };
}

/** The refusals that are only about a field nobody has filled in yet. */
const EMPTINESS = ["NAME_REQUIRED", "BRANCH_REQUIRED", "WORKTREE_REQUIRED"];

/**
 * The refusal to draw under a field, or `null` while there is nothing to say
 * yet.
 *
 * A dialog that opens with a red banner under an empty name is telling the
 * person off for not having typed yet. The plan still carries that refusal
 * and the button is still held, which is the honest way to say it: the field
 * only speaks up about something that was actually written there.
 */
export function inlineIssue(
  found: ProvisionIssue | null | undefined,
  value: string,
): ProvisionIssue | null {
  if (!found) return null;
  if (!value.trim() && EMPTINESS.includes(found.code)) return null;
  return found;
}
/**
 * The two ways of answering the one question the dialog asks.
 *
 * It used to ask a different one, "which kind of git object do you want", with
 * a tab for each answer, and the tab called "Worktree" was a piece of
 * plumbing on a screen where nothing else was. What a person actually decides
 * here is what the front is called, or what it is made from: a name they type,
 * or a branch they point at.
 */
export type NameMode = "name" | "branch";

/**
 * Moving between the two. Going back to the name lets go of the branch that
 * was pointed at and of everything that came with it, because a base, a
 * checkout and an adopted folder were all consequences of that choice.
 */
export function selectMode(row: FrontRow, mode: NameMode): FrontRow {
  if (mode === "branch") return row;
  return {
    ...row,
    kind: "new_worktree_new_branch",
    branch: "",
    baseRef: "",
    worktreePath: "",
  };
}

/**
 * What reusing a branch would mean, or `null` when it cannot be reused.
 *
 * git gives one worktree per branch, so a branch already checked out can only
 * be worked on where it already is: the project root, or the worktree holding
 * it. That is the whole table, and it is why "reuse" is one checkbox with
 * three different meanings instead of three destinations on a tab strip.
 */
export function reuseOf(where: BranchWhere): TargetKind | null {
  switch (where) {
    case "free":
      return "new_worktree_existing_branch";
    case "ground":
      return "current_workspace";
    case "worktree":
      return "existing_worktree";
    case "front":
      // Taking it would pull the files out from under the front working there.
      return null;
  }
}

/**
 * A branch pointed at, and what the row becomes.
 *
 * Unchecked, the branch is where the new one *grows from*, which is the
 * common case and the one the old dialog could not express without typing the
 * base by hand. Checked, the front is opened on that branch itself, wherever
 * it already lives. A branch another front holds falls back to the safe half:
 * growing from it takes nothing away from anybody.
 */
export function chooseBranch(row: FrontRow, choice: BranchChoice, reuse: boolean): FrontRow {
  const kind = reuse ? reuseOf(choice.where) : null;
  const named = { ...row, name: row.name || choice.name };
  if (!kind) {
    return { ...named, kind: "new_worktree_new_branch", branch: "", baseRef: choice.name, worktreePath: "" };
  }
  return {
    ...named,
    kind,
    branch: choice.name,
    baseRef: "",
    worktreePath: kind === "existing_worktree" ? (choice.path ?? "") : "",
  };
}

/**
 * What survives changing which project the front is being opened in.
 *
 * A branch, a base and a worktree belong to *one* repository. Carried across,
 * they ask the new project for a branch that is not there, and the refusal
 * arrives later, naming something the person never typed again. The name, the
 * request and the agent are theirs and stay.
 *
 * Adoption and the ground go back to the default tab: the worktree that was
 * chosen is in the other project, and the ground was that project's branch.
 * Keeping either leaves a row pointing at a place nobody is looking at.
 */
export function switchProject(row: FrontRow): FrontRow {
  return {
    ...row,
    kind:
      row.kind === "existing_worktree" || row.kind === "current_workspace"
        ? "new_worktree_new_branch"
        : row.kind,
    branch: "",
    baseRef: "",
    worktreeName: "",
    worktreePath: "",
  };
}

/**
 * The gesture that confirms without reaching for the mouse.
 *
 * Enter on its own is what a person presses after typing a name, so it must
 * not create anything; the modifier is what turns it into a decision.
 */
export function isConfirmGesture(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

export type BranchMode = "new" | "existing";

/** A branch picked from the repository is not a safe default for a new ref. */
export function selectBranchMode(row: FrontRow, mode: BranchMode): FrontRow {
  return {
    ...row,
    kind: mode === "new" ? "new_worktree_new_branch" : "new_worktree_existing_branch",
    branch: "",
    worktreePath: "",
  };
}

/**
 * Names every row from one pattern (`exp-{agent}-{index}`), making each result
 * unique as it goes. The uniqueness is not decoration: a pattern with no
 * placeholder in it — which is most of what people type first — would
 * otherwise name four rows the same and produce four refusals at the end.
 */
export function applyPattern(
  rows: readonly FrontRow[],
  pattern: string,
  agentOf: (row: FrontRow) => string,
): FrontRow[] {
  const taken = new Set<string>();
  return rows.map((row, index) => {
    const name = uniqueIn(expandPattern(pattern, { agent: agentOf(row), index }), taken);
    taken.add(name);
    return { ...row, name };
  });
}

/** One field, every row — the base, the prompt, the shape of the destination. */
export function applyToAll(rows: readonly FrontRow[], patch: Partial<FrontRow>): FrontRow[] {
  return rows.map((row) => ({ ...row, ...patch }));
}

/**
 * Copies a row, right below it.
 *
 * What is copied is the *shape* of the work — the kind, the base, the prompt,
 * the agent. What is cleared is the identity: name, branch and folder are
 * exactly the three fields two rows may not share, and a duplicate button
 * that carried them over would produce a row that can never be confirmed.
 */
export function duplicate(rows: readonly FrontRow[], id: string, newId: string): FrontRow[] {
  const at = rows.findIndex((r) => r.id === id);
  if (at < 0) return [...rows];
  const copy: FrontRow = { ...rows[at], id: newId, name: "", branch: "", worktreeName: "" };
  return [...rows.slice(0, at + 1), copy, ...rows.slice(at + 1)];
}

/**
 * Starts the next intent with the expensive choices preserved and everything
 * that identifies the finished work cleared.
 */
export function nextRowFrom(row: FrontRow, id: string): FrontRow {
  return newRow(id, {
    kind: row.kind,
    baseRef: row.baseRef,
    agentId: row.agentId,
  });
}

/** A single-agent editor must never retain invisible matrix rows in its plan. */
export function rowsForMode(rows: readonly FrontRow[], multi: boolean): FrontRow[] {
  return multi ? [...rows] : rows.slice(0, 1);
}

export function toSpecs(rows: readonly FrontRow[]): TargetSpec[] {
  return rows.map((r) => ({
    clientItemId: r.id,
    kind: r.kind,
    displayName: r.name,
    branchName: r.branch,
    worktreeName: r.worktreeName,
    baseRef: r.baseRef,
    worktreePath: r.worktreePath,
    agentId: r.agentId,
    prompt: r.prompt,
  }));
}

export interface PlanSummary {
  worktrees: number;
  branches: number;
  adopted: number;
  ground: number;
  agents: number;
}

/** What is about to be written — not how many rows there are. */
export function summaryOf(plan: Plan): PlanSummary {
  return {
    worktrees: plan.items.filter((i) => i.action === "create_worktree").length,
    branches: plan.items.filter((i) => i.action === "create_worktree" && !!i.base).length,
    adopted: plan.items.filter((i) => i.action === "adopt_worktree").length,
    ground: plan.items.filter((i) => i.action === "use_ground").length,
    agents: plan.items.filter((i) => !!i.agentId).length,
  };
}

export interface FrontProgress {
  settled: number;
  total: number;
  percent: number;
}

/** The progress bar advances only when a row reaches a terminal state. */
export function progressOf(items: readonly Pick<ItemReport, "state">[]): FrontProgress {
  const settled = items.filter((item) =>
    ["ready", "failed", "cancelled", "rolled_back", "cleanup_required"].includes(item.state),
  ).length;
  return {
    settled,
    total: items.length,
    percent: items.length ? Math.round((settled / items.length) * 100) : 0,
  };
}

/**
 * The warnings that hold the button until they are read.
 *
 * Only two, and both are the same risk: another writer in the same folder.
 * Everything else the plan warns about is worth *saying* and not worth a
 * checkbox, because a dialog that asks to tick five boxes teaches people to
 * tick without reading, which costs more than it saves.
 *
 * And the risk follows the writer. A row that starts no agent adds no second
 * hand to that folder: it is a tab bar over files the person already has
 * open. Asking them to acknowledge a collision that cannot happen was the
 * last thing between "quero trabalhar na main" and the button.
 */
const MATERIAL = ["WORKTREE_SHARED", "GROUND_IN_USE"];

export function materialWarnings(plan: Plan): ProvisionIssue[] {
  const seen = new Set<string>();
  const out: ProvisionIssue[] = [];
  for (const item of plan.items) {
    if (!item.agentId) continue;
    for (const w of item.warnings) {
      if (!MATERIAL.includes(w.code) || seen.has(w.code)) continue;
      seen.add(w.code);
      out.push(w);
    }
  }
  return out;
}

export function canConfirm(plan: Plan, acknowledged: readonly string[]): boolean {
  if (!plan.valid || plan.items.length === 0) return false;
  return materialWarnings(plan).every((w) => acknowledged.includes(w.code));
}
