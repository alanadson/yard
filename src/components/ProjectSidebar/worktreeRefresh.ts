import type { GroupRow, ProjectRow } from "../../lib/ipc";
import { rootKey } from "../../lib/roots";

type Project = Pick<ProjectRow, "id" | "path">;

/** Group membership matters; layout edits and loose boards do not change worktrees. */
export function worktreeRefreshPlan(
  previous: ReadonlyMap<string, string>,
  projects: readonly Project[],
  groups: readonly Pick<GroupRow, "id" | "projectId">[],
) {
  const members = new Map<string, string[]>();
  for (const group of groups) {
    if (!group.projectId) continue;
    const ids = members.get(group.projectId) ?? [];
    ids.push(group.id);
    members.set(group.projectId, ids);
  }
  const scopes = new Map<string, string>();
  const refresh: Project[] = [];
  for (const project of projects) {
    const scope = JSON.stringify([
      rootKey(project.path),
      (members.get(project.id) ?? []).sort(),
    ]);
    scopes.set(project.id, scope);
    if (previous.get(project.id) !== scope) refresh.push(project);
  }
  return {
    scopes,
    refresh,
    forget: [...previous.keys()].filter((id) => !scopes.has(id)),
  };
}
