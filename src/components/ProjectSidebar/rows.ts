/**
 * The sidebar's two rules that are not markup.
 *
 * `treeRows` is the order the rows are painted **and** the order the arrow
 * keys walk. The bar has two sections since boards arrived — the boards on
 * top, the projects below — and keeping the walk in one flat list is what lets
 * Down carry the focus out of the last board and into the first project
 * instead of dead-ending there.
 *
 * `cardOrigin` is the label a card carries on a board. A board mixes projects
 * on purpose, so two cards called "Claude Code" are told apart only by where
 * they are running.
 */
import { isBranchNamed, type FloorMeta } from "../../lib/floors";
import { rootKey } from "../../lib/roots";
import type { Surface } from "../../lib/surface";

/** `"sidebar"` is the bar's background: the menu that speaks of no row. */
export type TreeKind = "board" | "project" | "group" | "terminal" | "sidebar";

export interface TreeRow {
  id: string;
  kind: TreeKind;
}

/** Which of the bar's two sections are painted. */
export interface Sections {
  boards: boolean;
  projects: boolean;
}

/**
 * The bar answers to the surface on screen.
 *
 * On the canvas the only thing that can be on it is a board, so the projects
 * tree is not a useful shortcut there — it is a list of things that cannot be
 * shown, taking the height from the one list that can. On the panes the
 * inverse holds: the Canvas row above the tree is the door into boards, so
 * only the project tree stays in the sidebar.
 */
export function sectionsFor(surface: Surface): Sections {
  return { boards: surface === "canvas", projects: surface !== "canvas" };
}

interface HasId {
  id: string;
}

export function treeRows(world: {
  /** A section that is not painted is not walked either. */
  sections: Sections;
  boards: HasId[];
  projects: HasId[];
  groupsOf: (projectId: string) => HasId[];
  cardsOf: (groupId: string) => HasId[];
  collapsed: Record<string, boolean>;
}): TreeRow[] {
  const out: TreeRow[] = [];
  for (const b of world.sections.boards ? world.boards : []) {
    out.push({ id: b.id, kind: "board" });
    if (world.collapsed[b.id]) continue;
    for (const c of world.cardsOf(b.id)) out.push({ id: c.id, kind: "terminal" });
  }
  for (const p of world.sections.projects ? world.projects : []) {
    out.push({ id: p.id, kind: "project" });
    if (world.collapsed[p.id]) continue;
    for (const g of world.groupsOf(p.id)) {
      out.push({ id: g.id, kind: "group" });
      if (world.collapsed[g.id]) continue;
      for (const t of world.cardsOf(g.id)) out.push({ id: t.id, kind: "terminal" });
    }
  }
  return out;
}

/**
 * Which project a working directory sits in, by name — `null` when it sits in
 * none (a folder the user picked by hand, a worktree of a closed project).
 *
 * The comparison is segment-by-segment and not a plain prefix: `.../yard` must
 * not swallow `.../yard-antigo`, which is a real neighbour of a real project
 * on this machine. The deepest match wins, so a project nested inside another
 * gives the closer, more useful answer.
 */
export function cardOrigin(
  projects: { name: string; path: string }[],
  cwd: string,
): string | null {
  if (!cwd.trim()) return null;
  const target = rootKey(cwd);
  let best: { name: string; depth: number } | null = null;
  for (const p of projects) {
    const root = rootKey(p.path);
    if (!root) continue;
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    const depth = root.length;
    if (!best || depth > best.depth) best = { name: p.name, depth };
  }
  return best?.name ?? null;
}

/**
 * The branch a group row prints beside its name.
 *
 * A project's children are branches and worktrees now, not folders: the ground
 * is the project's own root on whatever branch is checked out there, and each
 * front is a `git worktree` with a branch of its own. Without this the tree
 * still reads as the folder list it stopped being.
 *
 * The groups made before the change (`plain`) have no worktree: they run in
 * the root, so they carry the root's branch like the ground does.
 */
/**
 * The ground of a project that has no repository at all.
 *
 * Two projects side by side, one printing `master` and the other "Principal",
 * differ for a reason the tree never states: the second folder has no `.git`,
 * so there is no branch to print and the row falls back to a stored name that
 * reads exactly like a branch could. The row has to say which of the two it
 * is looking at.
 *
 * `listed` is what keeps it honest. Before `git worktree list` comes back
 * there is no branch *yet*, and announcing "sem git" over a repository that
 * has simply not answered is a worse lie than the silence it replaces.
 */
export function groundWithoutGit(
  floor: FloorMeta,
  groundBranch: string | null | undefined,
  listed: boolean,
): boolean {
  return floor.kind === "ground" && listed && !groundBranch?.trim();
}

export function groupBranch(
  floor: FloorMeta,
  groundBranch: string | null | undefined,
): string | null {
  if (floor.kind === "isolated") return floor.branch ?? null;
  // The ground's branch is already its name (`groupLabel`); a chip repeating
  // it would print `main` twice on one row.
  if (isBranchNamed(floor, groundBranch)) return null;
  return groundBranch ?? null;
}
