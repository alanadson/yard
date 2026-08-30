/**
 * The two translations between the app and the plan.
 *
 * One way out: the rows of the dialog, in the shape the backend's preflight
 * reads. One way in: the app's own state, in the shape the planner reads —
 * which fronts already own which folder, where an agent is alive, which names
 * are spoken for.
 *
 * Both are pure and both live here rather than inside the dialog, because
 * three surfaces ask the same questions (the front dialog, "Nova aba", the
 * palette) and the three answering slightly differently is exactly how two
 * fronts end up sharing one worktree.
 */
import type { FloorMeta } from "../floors";
import type { PreflightItem } from "../ipc";
import { rootKey } from "../roots";
import { preflightKindOf, type PlanWorld, type TargetSpec } from "./plan";

export interface WorldInput {
  projectId: string;
  projectPath: string;
  groups: readonly { id: string; projectId: string | null; name: string }[];
  floorOf: (groupId: string) => FloorMeta;
  terminals: readonly { id: string; groupId: string; alive: boolean }[];
  availableAgents: readonly string[];
}

export function worldFrom(input: WorldInput): PlanWorld {
  const mine = input.groups.filter((g) => g.projectId === input.projectId);

  const ownedPaths: Record<string, string> = {};
  /** The folder each group of this project runs in, for the count below. */
  const folderOf = new Map<string, string>();
  for (const g of mine) {
    const floor = input.floorOf(g.id);
    const worktree = floor.kind === "isolated" ? floor.worktreePath : undefined;
    folderOf.set(g.id, rootKey(worktree ?? input.projectPath));
    // Adopted or created, an isolated front owns its folder: the failure this
    // guards is two groups on one worktree, where closing either one takes
    // the files out from under the other.
    if (worktree) ownedPaths[rootKey(worktree)] = g.name;
  }

  const busyPaths: Record<string, number> = {};
  for (const t of input.terminals) {
    if (!t.alive) continue;
    const key = folderOf.get(t.groupId);
    if (!key) continue;
    busyPaths[key] = (busyPaths[key] ?? 0) + 1;
  }

  return {
    takenNames: mine.map((g) => g.name),
    ownedPaths,
    busyPaths,
    availableAgents: input.availableAgents,
  };
}

/** Blank means "you decide"; anything typed travels exactly as typed. */
const typed = (v: string | undefined): string | null => {
  const s = v?.trim();
  return s ? s : null;
};

export function specsToPreflight(specs: readonly TargetSpec[]): PreflightItem[] {
  return specs.map((s) => ({
    id: s.clientItemId,
    kind: preflightKindOf(s.kind),
    name: s.displayName.trim(),
    branch: typed(s.branchName),
    worktreeName: typed(s.worktreeName),
    baseRef: typed(s.baseRef),
    worktreePath: typed(s.worktreePath),
  }));
}
