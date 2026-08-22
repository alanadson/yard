/**
 * From `git status` (a flat list) to the three groups of the Source Control tab.
 *
 * The rule this module carries is the one the rest of the panel assumes: the
 * index and the working tree are **two independent sides**. The same path can
 * be staged *and* touched again, and in that case it is two rows — with
 * different verbs, different buttons and, what matters most, different diffs
 * (`side`), because staging a hunk taken from the wrong comparison simply
 * does not apply.
 *
 * It lives outside the JSX because it is all agreement and ordering: the kind
 * of thing that looks right on the screen you are looking at and is wrong on
 * the other two.
 */
import type { ChangedFile, GitFileStatus, ScmDiffSide } from "./ipc";

export type ScmGroupId = "conflicts" | "staged" | "changes";

export interface ScmRow {
  /** Stable and unique per row — the same file in two groups, two keys. */
  key: string;
  path: string;
  origPath: string | null;
  /** The verb **of that side**, not the file's summary. */
  status: GitFileStatus;
  group: ScmGroupId;
  binary: boolean;
  additions: number | null;
  deletions: number | null;
  /** The raw conflict pair (`UU`, `DU`…); `null` outside the conflicts group. */
  conflict: string | null;
  untracked: boolean;
  /** Which comparison this row's diff asks the backend for. */
  side: ScmDiffSide;
  canStage: boolean;
  canUnstage: boolean;
  canDiscard: boolean;
}

export interface ScmGroup {
  id: ScmGroupId;
  label: string;
  rows: ScmRow[];
}

const LABELS: Record<ScmGroupId, string> = {
  conflicts: "Conflitos",
  staged: "Preparado",
  changes: "Alterações",
};

/** The order is fixed: urgency first, then what goes into the commit, then the rest. */
const ORDER: ScmGroupId[] = ["conflicts", "staged", "changes"];

/**
 * A single comparator, built once.
 *
 * `a.localeCompare(b)` builds an `Intl.Collator` **per comparison**; in a
 * repository with two thousand files that is ~22 thousand builds per tick of
 * the watcher, and `git status` ticks every 1.2 s while an agent is saving
 * files. Reusing the instance gives the same order at a tenth of the cost.
 *
 * No options, on purpose: it is exactly what `localeCompare()` does on its
 * own, and changing the order of the names was not the point.
 */
const nameOrder = new Intl.Collator().compare;

/** How many rows of a group show up at once. */
export const SCM_ROWS_PAGE = 200;

export interface ScmPage<T> {
  rows: T[];
  /** How many were left out — the number the footer says out loud. */
  hidden: number;
}

/**
 * The window of rows of a group.
 *
 * It exists because of the DOM, not git: every row in the Source Control tab
 * is a dozen nodes (four buttons, three SVGs, four `data-tip` tooltips), and
 * a repository with two thousand touched files reached fifty thousand nodes —
 * enough to freeze the window when opening the tab and on every click,
 * because every write redraws the whole list.
 *
 * Returns the **same reference** when nothing was cut: that is the common
 * case, and a copy per render would defeat the rows' `memo`.
 */
export function pageRows<T>(rows: T[], shown: number): ScmPage<T> {
  if (rows.length <= shown) return { rows, hidden: 0 };
  return { rows: rows.slice(0, shown), hidden: rows.length - shown };
}

export function groupChanges(files: ChangedFile[]): ScmGroup[] {
  const buckets: Record<ScmGroupId, ScmRow[]> = {
    conflicts: [],
    staged: [],
    changes: [],
  };

  for (const f of files) {
    if (f.status === "conflicted" || f.index === "conflicted" || f.worktree === "conflicted") {
      buckets.conflicts.push(row(f, "conflicts", "conflicted"));
      continue;
    }
    if (f.index !== "none" && f.index !== "untracked") {
      buckets.staged.push(row(f, "staged", f.index as GitFileStatus));
    }
    if (f.worktree !== "none") {
      buckets.changes.push(row(f, "changes", f.worktree as GitFileStatus));
    }
  }

  return ORDER.filter((id) => buckets[id].length > 0).map((id) => ({
    id,
    label: LABELS[id],
    rows: buckets[id].sort((a, b) => nameOrder(a.path, b.path)),
  }));
}

function row(f: ChangedFile, group: ScmGroupId, status: GitFileStatus): ScmRow {
  const untracked = status === "untracked";
  return {
    key: `${group}:${f.path}`,
    path: f.path,
    origPath: f.origPath,
    status,
    group,
    binary: f.binary,
    additions: f.additions,
    deletions: f.deletions,
    conflict: group === "conflicts" ? f.conflict : null,
    untracked,
    // A conflict has no "staged side" that makes sense to read: what the
    // person wants to see is the file with the markers, which is the disk.
    side: group === "staged" ? "index" : "worktree",
    canStage: group !== "staged",
    canUnstage: group === "staged",
    // Discarding a conflict mid-merge is aborting the merge, not deleting a
    // file — and that button lives in the banner at the top, with the right name.
    canDiscard: group === "changes",
  };
}

export interface ScmCounts {
  staged: number;
  changes: number;
  conflicts: number;
  /**
   * New files, counted separately. `changes` already includes them, but the
   * "discard all" warning needs to separate what **goes back** to the last
   * commit from what **vanishes from disk** — two different consequences, and
   * this is the only count that gives the second one.
   */
  untracked: number;
  /** Distinct files — one that is on both sides counts only once. */
  total: number;
}

export function scmCounts(files: ChangedFile[]): ScmCounts {
  let staged = 0;
  let changes = 0;
  let conflicts = 0;
  let untracked = 0;
  const paths = new Set<string>();
  for (const f of files) {
    paths.add(f.path);
    if (f.status === "conflicted" || f.index === "conflicted" || f.worktree === "conflicted") {
      conflicts++;
      continue;
    }
    if (f.index !== "none" && f.index !== "untracked") staged++;
    if (f.worktree !== "none") changes++;
    if (f.worktree === "untracked") untracked++;
  }
  return { staged, changes, conflicts, untracked, total: paths.size };
}

/**
 * The `XY` pair `git status` writes for an unmerged file. Each one is a
 * different fight and asks for a different resolution — "both modified"
 * chooses between two texts, "they deleted" chooses between existing and not
 * existing. Calling all six "conflict" throws away the only useful information.
 */
const CONFLICTS: Record<string, string> = {
  UU: "os dois mexeram",
  AA: "os dois adicionaram",
  DD: "os dois apagaram",
  DU: "eu apaguei, eles mexeram",
  UD: "eu mexi, eles apagaram",
  AU: "só eu adicionei",
  UA: "só eles adicionaram",
};

export function conflictKind(pair: string | null | undefined): string {
  if (!pair) return "conflito";
  return CONFLICTS[pair] ?? "conflito";
}
