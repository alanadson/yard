/**
 * What the app believes about its fronts, checked against git and the disk.
 *
 * Everything a batch writes lives outside the app (a folder, a branch, an
 * entry in `.git/worktrees`), so the two can drift, and every way they drift
 * is invisible on screen. A front whose folder somebody deleted from Explorer
 * still shows a name, a branch and a tab bar, and offers to open a terminal
 * in a directory that is not there. A worktree the app died halfway through
 * creating sits on the disk with nothing pointing at it, and turns up a week
 * later in somebody's `git worktree list`.
 *
 * One rule shapes the whole module: **it decides, it does not act.** It says
 * a folder is gone; it does not prune. It says a worktree has no front; it
 * does not adopt one. §14 of the design is blunt about why: an operation may
 * only clean up what it recorded as its own, and by the time this runs the
 * journal that recorded it is gone with the process that wrote it. "The
 * folder looks like ours" is a guess, and deleting on a guess is the one
 * mistake here nobody can undo.
 *
 * Pure: the disk is a lookup table the caller fills in.
 */
import type { WorktreeEntry } from "../ipc";
import { rootKey } from "../roots";

/** One isolated front, as the app has it written down. */
export interface FrontRecord {
  groupId: string;
  name: string;
  path: string;
  /** The Yard did not create it, so the Yard never removes it. */
  adopted: boolean;
}

/**
 * `ok`: folder there, git lists it.
 * `repair_required`: folder there, git forgot it (`git worktree repair`).
 * `orphaned`: folder gone; only a person decides what that means.
 */
export type FrontHealth = "ok" | "repair_required" | "orphaned";

export interface FrontFinding {
  groupId: string;
  name: string;
  path: string;
  health: FrontHealth;
  adopted: boolean;
}

/** A worktree git knows about that no front has opened. */
export interface LooseWorktree {
  path: string;
  branch: string | null;
}

export interface Reconciliation {
  fronts: FrontFinding[];
  unregistered: LooseWorktree[];
  /** Entries `git worktree prune` would clear. Listed, never run. */
  prunable: string[];
  /** A front lost its folder or its git entry. Only that is worth a person. */
  needsAttention: boolean;
  /** One line, empty when there is nothing to say. */
  summary: string;
}

export interface ReconcileInput {
  groundPath: string;
  fronts: readonly FrontRecord[];
  /** What `git worktree list` says right now. */
  worktrees: readonly WorktreeEntry[];
  /** Path → is the folder there. Keyed exactly as the paths were handed in. */
  exists: Readonly<Record<string, boolean>>;
}

export function reconcile(input: ReconcileInput): Reconciliation {
  const ground = rootKey(input.groundPath);

  // A project on a drive that is not plugged in today. Every front of it
  // looks orphaned and not one of them is: the whole checkout is simply not
  // there, and the recommended action would be wrong. Absence of an entry is
  // not a claim: only an explicit `false` for the ground stops the reading.
  if (input.exists[input.groundPath] === false) {
    return {
      fronts: input.fronts.map((f) => ({ ...f, health: "ok" as const })),
      unregistered: [],
      prunable: [],
      needsAttention: false,
      summary: "",
    };
  }

  const listed = new Set(input.worktrees.map((w) => rootKey(w.path)));
  // Keyed by the *caller's* spelling, because that is what the lookup table
  // was built from; compared by `rootKey`, because `C:\a\B\` and `c:/a/b` are
  // one folder on the platform this runs on.
  const onDisk = new Map<string, boolean>();
  for (const [path, there] of Object.entries(input.exists)) onDisk.set(rootKey(path), there);
  const here = (path: string): boolean => onDisk.get(rootKey(path)) ?? false;

  const fronts: FrontFinding[] = input.fronts.map((f) => ({
    groupId: f.groupId,
    name: f.name,
    path: f.path,
    adopted: f.adopted,
    health: !here(f.path)
      ? "orphaned"
      : listed.has(rootKey(f.path))
        ? "ok"
        : "repair_required",
  }));

  const owned = new Set(input.fronts.map((f) => rootKey(f.path)));
  const unregistered: LooseWorktree[] = [];
  const prunable: string[] = [];
  for (const w of input.worktrees) {
    const key = rootKey(w.path);
    if (w.bare || key === ground) continue;
    // A folder that is not there is a prune, whoever it belonged to. Offering
    // it for adoption would offer a front on nothing.
    if (!here(w.path)) {
      prunable.push(w.path);
      continue;
    }
    if (!owned.has(key)) unregistered.push({ path: w.path, branch: w.branch });
  }

  const hurt = fronts.filter((f) => f.health !== "ok");
  return {
    fronts,
    unregistered,
    prunable,
    // A loose worktree is worth *saying* and is not a problem: somebody made
    // it with git, on purpose. Raising it to the level of a front with no
    // folder teaches people to dismiss the warning that matters.
    needsAttention: hurt.length > 0,
    summary: summaryOf(hurt),
  };
}

function summaryOf(hurt: readonly FrontFinding[]): string {
  if (hurt.length === 0) return "";
  const gone = hurt.filter((f) => f.health === "orphaned").map((f) => `"${f.name}"`);
  const broken = hurt.filter((f) => f.health === "repair_required").map((f) => `"${f.name}"`);
  const parts: string[] = [];
  // Named, not counted: "2 frentes com problema" sends nobody anywhere.
  if (gone.length) {
    parts.push(
      `${gone.join(", ")} ${gone.length === 1 ? "perdeu a pasta" : "perderam a pasta"}`,
    );
  }
  if (broken.length) {
    parts.push(
      `${broken.join(", ")} ${broken.length === 1 ? "existe no disco" : "existem no disco"} ` +
        "mas o git não lista mais (`git worktree repair`)",
    );
  }
  return `${parts.join("; ")}. Nada foi apagado.`;
}
