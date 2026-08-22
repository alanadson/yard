/**
 * Landing a floor: merge its branch onto the ground, then optionally
 * close the winner and the other floors of the same task.
 *
 * The merge itself is a Rust command (`worktree_land`) so a UI reload
 * mid-gesture cannot leave the ground half-merged. This file is the
 * workspace half: who to close afterwards, which group to show.
 */
import { closeFloor } from "./floorClose";
import { isIsolatedFloor } from "./floors";
import { ipc, type GroupRow, type LandResult, type ProjectRow } from "./ipc";
import { parseLayout, useProjects } from "../stores/projectsStore";

export async function previewFloor(
  project: ProjectRow,
  group: GroupRow,
) {
  const floor = parseLayout(group.layoutJson).floor;
  if (!isIsolatedFloor(floor) || !floor?.branch) {
    throw new Error(`o andar "${group.name}" não tem uma branch para aterrissar`);
  }
  return ipc.worktreePreview(project.path, floor.branch, floor.worktreePath);
}

export async function landFloor(
  project: ProjectRow,
  group: GroupRow,
): Promise<LandResult> {
  const floor = parseLayout(group.layoutJson).floor;
  if (!isIsolatedFloor(floor) || !floor?.branch) {
    throw new Error(`o andar "${group.name}" não tem uma branch para aterrissar`);
  }
  return ipc.worktreeLand(project.path, floor.branch, floor.worktreePath);
}

/** Isolated floors of this project that share the task (or just `except`). */
export function siblingFloors(
  projectId: string,
  exceptId: string,
  taskId?: string,
): GroupRow[] {
  return useProjects
    .getState()
    .groupsOf(projectId)
    .filter((g) => {
      if (g.id === exceptId) return false;
      const floor = parseLayout(g.layoutJson).floor;
      if (!isIsolatedFloor(floor)) return false;
      if (taskId) return floor?.task?.id === taskId;
      return false;
    });
}

export function groundGroup(projectId: string): GroupRow | undefined {
  return useProjects
    .getState()
    .groupsOf(projectId)
    .sort((a, b) => a.sort - b.sort)[0];
}

/**
 * After a successful merge: switch to the ground, close the winner, and
 * (when asked) the other floors of the same fan-out. Failures closing a
 * loser are collected — the merge already happened and must not roll back.
 */
export async function settleAfterLand(opts: {
  project: ProjectRow;
  winner: GroupRow;
  closeWinner: boolean;
  closeSiblings: boolean;
}): Promise<string[]> {
  const s = useProjects.getState();
  const ground = groundGroup(opts.project.id);
  if (ground) s.setActiveGroup(ground.id);

  const warnings: string[] = [];
  const floor = parseLayout(opts.winner.layoutJson).floor;
  const others = opts.closeSiblings
    ? siblingFloors(opts.project.id, opts.winner.id, floor?.task?.id)
    : [];

  const closeIt = async (g: GroupRow, skipDirty: boolean) => {
    try {
      await closeFloor({
        project: opts.project,
        group: g,
        deleteBranch: true,
        skipDirtyCheck: skipDirty,
      });
    } catch (e) {
      warnings.push(`"${g.name}": ${e}`);
    }
  };

  if (opts.closeWinner) await closeIt(opts.winner, true);
  for (const g of others) await closeIt(g, false);
  return warnings;
}
