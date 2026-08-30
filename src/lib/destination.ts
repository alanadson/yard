/**
 * Where a CLI is born inside a project.
 *
 * A project's children are branches and worktrees now, not folders. What used
 * to be "Novo grupo", a bare group sharing the root's files and the root's
 * branch, so that two of them were the same working copy under two names, is
 * gone from every door in the app; what is left is the **ground** (the
 * project's own root, on whatever branch is checked out there) and the
 * **fronts** (a `git worktree` each, with a branch of their own).
 *
 * This module is the list of those places, and it is pure on purpose: the
 * picker in "Nova aba", the "Abrir frente" dialog and the sidebar all have to
 * agree on which worktrees are still free to adopt, and the disagreement is
 * invisible until an agent is already writing files in the wrong copy.
 *
 * Nothing here creates anything. Picking `NEW_FRONT` is the caller's cue to
 * open the front dialog; picking a `worktree` entry is the cue to adopt it.
 */
import { t } from "./i18n";
import type { WorktreeEntry } from "./ipc";
import { groupLabel, type FloorMeta } from "./floors";
import { rootKey } from "./roots";

/**
 * - `ground`: the project's own root. The legacy folder-groups land here too:
 *   they have no worktree, so the root is exactly where they run.
 * - `front`: a group that already owns an isolated worktree.
 * - `worktree`: a worktree git knows about that no group has opened yet.
 * - `new`: the door to the "Abrir frente" dialog, always last.
 */
export type DestinationKind = "ground" | "front" | "worktree" | "new";

export interface Destination {
  /** Stable key for the picker: `group:<id>`, `worktree:<key>`, `new`. */
  value: string;
  kind: DestinationKind;
  /** What the picker prints. */
  label: string;
  /** Heading the picker groups under. */
  heading: string;
  /** The group this destination already has, when it has one. */
  groupId?: string;
  /** The folder a CLI would run in. Absent on `new`. */
  path?: string;
  /** The branch checked out there, when git said so. */
  branch?: string | null;
}

export interface DestinationInput {
  projectPath: string;
  /** Every group of this project, in any order. */
  groups: readonly { id: string; name: string; sort: number }[];
  floorOf: (groupId: string) => FloorMeta;
  /** `git worktree list` for the project, or an empty list when it has no git. */
  worktrees: readonly WorktreeEntry[];
  /** The branch checked out at the root, when it is known. */
  groundBranch?: string | null;
}

/** The value of the entry that opens the "Abrir frente" dialog. */
export const NEW_FRONT = "new";

export const groupValue = (groupId: string): string => `group:${groupId}`;
export const worktreeValue = (path: string): string => `worktree:${rootKey(path)}`;

/**
 * The ground first, then the fronts by `sort`, then the worktrees still free,
 * and the new-front door last.
 */
export function destinationsOf(input: DestinationInput): Destination[] {
  const out: Destination[] = [];
  const taken = new Set<string>([rootKey(input.projectPath)]);

  const ordered = [...input.groups].sort((a, b) => a.sort - b.sort);
  for (const g of ordered) {
    const floor = input.floorOf(g.id);
    const isolated = floor.kind === "isolated" && !!floor.worktreePath;
    const path = isolated ? floor.worktreePath! : input.projectPath;
    if (isolated) taken.add(rootKey(path));
    const branch = isolated ? (floor.branch ?? null) : (input.groundBranch ?? null);
    // The ground is called by its branch, like everywhere else the tree names
    // it (`groupLabel`); the others keep their own name with the branch beside
    // it, which is what tells two tasks on one repository apart.
    const named = groupLabel({ name: g.name, floor, groundBranch: input.groundBranch });
    out.push({
      value: groupValue(g.id),
      kind: isolated ? "front" : "ground",
      label: branch && named !== branch ? `${named} · ${branch}` : named,
      heading: isolated ? t("Frentes") : t("Chão"),
      groupId: g.id,
      path,
      branch,
    });
  }

  for (const w of input.worktrees) {
    // A bare worktree has no files to run in, and the root is the ground.
    if (w.bare || taken.has(rootKey(w.path))) continue;
    taken.add(rootKey(w.path));
    out.push({
      value: worktreeValue(w.path),
      kind: "worktree",
      label: w.branch ?? w.path,
      heading: t("Worktrees do disco"),
      path: w.path,
      branch: w.branch,
    });
  }

  out.push({
    value: NEW_FRONT,
    kind: "new",
    label: t("Nova frente…"),
    heading: t("Abrir"),
  });
  return out;
}

/**
 * The entry a dialog opens on: the group in view when it is one of these, and
 * the ground otherwise. A CLI asked for with no branch and no worktree
 * chosen runs in the project's root, which is the answer the app owed and
 * used to fake.
 */
export function defaultDestination(
  list: readonly Destination[],
  activeGroupId: string | null | undefined,
): string {
  if (activeGroupId) {
    const inView = list.find((d) => d.groupId === activeGroupId);
    if (inView) return inView.value;
  }
  return list.find((d) => d.kind === "ground")?.value ?? "";
}

/** Where a branch is already checked out, which is what reusing it would mean. */
export type BranchWhere =
  /** Nowhere: a new worktree can take it. */
  | "free"
  /** The project's own root: reusing it means working in the copy already open. */
  | "ground"
  /** A worktree on the disk that no front opened: reusing it adopts that worktree. */
  | "worktree"
  /** A worktree another front already works in: it cannot be reused. */
  | "front";

/** A local branch, and where it already lives. */
export interface BranchChoice {
  name: string;
  where: BranchWhere;
  /** The worktree holding it, or `null` when it is free. */
  path: string | null;
}

/**
 * The branches a front can be opened from.
 *
 * Every local branch is here, and that is the point. Picking one does not mean
 * "check this out": it means "start from here", which any branch can answer,
 * including the one the project root has open. What differs between them is
 * what *reusing* one would do, and that is `where`: git gives one worktree per
 * branch, so a branch already checked out can only be worked on where it
 * already is (the ground, or the worktree holding it), and one held by another
 * front cannot be taken at all without pulling the files out from under it.
 *
 * The remotes are out entirely: a worktree on `origin/main` detaches HEAD,
 * which is never what the person picking a branch from this list meant.
 */
export function branchChoices(
  branches: readonly { name: string; remote: boolean }[],
  worktrees: readonly WorktreeEntry[],
  opts: { groundPath?: string; ownedPaths?: readonly string[] } = {},
): BranchChoice[] {
  const at = new Map<string, string>();
  for (const w of worktrees) {
    if (w.branch && !at.has(w.branch)) at.set(w.branch, w.path);
  }
  const ground = opts.groundPath ? rootKey(opts.groundPath) : null;
  const owned = new Set((opts.ownedPaths ?? []).map(rootKey));

  const out: BranchChoice[] = [];
  for (const b of branches) {
    if (b.remote) continue;
    const path = at.get(b.name) ?? null;
    const key = path ? rootKey(path) : null;
    const where: BranchWhere = !key
      ? "free"
      : key === ground
        ? "ground"
        : owned.has(key)
          ? "front"
          : "worktree";
    // The ground first: it is the one people ask for by name.
    if (where === "ground") out.unshift({ name: b.name, where, path });
    else out.push({ name: b.name, where, path });
  }
  return out;
}

/**
 * The branch checked out at the project's own root.
 *
 * It comes from `git worktree list`, which names the root's branch on the same
 * wire that lists the worktrees beside it: a second `git status` for the
 * ground would be a whole process for something already in hand.
 */
export function groundBranchOf(
  worktrees: readonly WorktreeEntry[],
  projectPath: string,
): string | null {
  const key = rootKey(projectPath);
  return worktrees.find((w) => rootKey(w.path) === key)?.branch ?? null;
}

/**
 * The folder a CLI is spawned in.
 *
 * The regression behind this line: the dialog spawned every CLI in the
 * *project's* root, so one opened inside an isolated front carried the front's
 * name in its tab and edited the files of the ground.
 */
export function cwdFor(dest: Destination | undefined, projectPath: string): string {
  return dest?.path ?? projectPath;
}

/** The chosen entry, or `undefined` when the list moved under the dialog. */
export function destinationAt(
  list: readonly Destination[],
  value: string,
): Destination | undefined {
  return list.find((d) => d.value === value);
}
