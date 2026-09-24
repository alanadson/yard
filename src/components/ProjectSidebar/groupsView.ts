/**
 * The groups, as the sidebar reads them.
 *
 * The tree paints four fields of every group (id, project, name, `sort`) and
 * the floor of a project's group (the branch chip, the ground's label, the
 * rename rule). Everything else a group carries is in `layoutJson` and moves
 * all the time: a board's canvas on every keystroke in a note, its viewport on
 * every pan, a group's active tab on every click. Subscribed to the raw
 * `groups` array, each of those writes reconciled the whole tree.
 *
 * The selector below keeps handing out the previous array while none of the
 * painted fields changed. The rows in a kept array may carry an older
 * `layoutJson`, which is safe only because the tree reads nothing from it but
 * the floor, and the floor is part of the comparison. A new field painted in
 * the sidebar has to be added to `sameGroup`, or it will paint stale.
 */
import type { GroupRow } from "../../lib/ipc";
import { stableSelect } from "../../lib/stableSelect";
import { parseLayout } from "../../stores/projectsStore";

/**
 * The floor, as a comparable string. `parseLayout` caches by the layout
 * string, so this is a cache hit for every row the write did not touch (and
 * those are skipped before getting here anyway, by identity).
 */
function floorKey(group: GroupRow): string {
  return JSON.stringify(parseLayout(group.layoutJson).floor ?? null);
}

function sameGroup(a: GroupRow, b: GroupRow): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.projectId !== b.projectId || a.name !== b.name || a.sort !== b.sort) {
    return false;
  }
  if (a.layoutJson === b.layoutJson) return true;
  // A board's floor is never painted (a board is its own section and has no
  // branch), and its layout is the big one, rewritten on every keystroke in
  // a note: parsing it here would be work nobody reads.
  if (a.projectId === null) return true;
  return floorKey(a) === floorKey(b);
}

/** Every painted field of every group equal, in the same order. */
export function sameSidebarGroups(prev: readonly GroupRow[], next: readonly GroupRow[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) if (!sameGroup(prev[i], next[i])) return false;
  return true;
}

/** One per mounted sidebar: it remembers the array it handed out last. */
export function sidebarGroupsSelector(): (s: { groups: GroupRow[] }) => GroupRow[] {
  return stableSelect((s: { groups: GroupRow[] }) => s.groups, sameSidebarGroups);
}
