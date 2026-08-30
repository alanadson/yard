/**
 * The plan: what is about to happen, written down before it happens.
 *
 * The old dialog asked three questions and then ran `git worktree add`. Every
 * refusal, therefore, arrived *after* the click, as git's own stderr, in
 * English, naming paths nobody had typed — and half of them arrived with a
 * folder already on the disk and a branch already created. Which of the two
 * had happened was never on screen.
 *
 * So the click is split in two. First a plan is built out of two answers that
 * are useless apart:
 *
 * - what git holds (`ipc.worktreePreflight`): branch names it would refuse,
 *   branches already checked out somewhere, folders in the way, the commit
 *   each base resolves to;
 * - what the app holds (`PlanWorld`): which front already owns which
 *   worktree, which agent is alive where, which names are spoken for.
 *
 * Only together do they catch the failure that costs the most in a batch:
 * four rows, each free on its own, all four asking for one branch — because
 * git is asked one row at a time and answers "free" four times.
 *
 * Everything here is pure. The clock and the plan's id are arguments: a plan
 * that stamped itself with `Date.now()` could not be tested for the one thing
 * that matters about staleness, which is that it expires.
 */
import type { Preflight, PreflightItemResult } from "../ipc";
import { rootKey } from "../roots";
import { blockers, issue, notices, type ProvisionIssue } from "./errors";

/** The four shapes a front can have. Nothing else creates a working copy. */
export type TargetKind =
  | "new_worktree_new_branch"
  | "new_worktree_existing_branch"
  | "existing_worktree"
  | "current_workspace";

/** What the executor will actually do. One row, one verb. */
export type PlanAction =
  | "create_worktree"
  | "adopt_worktree"
  | "use_ground"
  /** A project with no git: the front is a group sharing the ground's folder. */
  | "create_folder";

/** One row of the dialog, exactly as the person left it. */
export interface TargetSpec {
  clientItemId: string;
  kind: TargetKind;
  /** What the front is called on screen. Never derived from the other two. */
  displayName: string;
  branchName?: string;
  worktreeName?: string;
  baseRef?: string;
  worktreePath?: string;
  /**
   * The person asked for a front with no branch of its own, in a repository
   * that has one. It shares the ground's folder (`yard floor create --no-git`)
   * and is the one way a `create_folder` happens on purpose.
   */
  noGit?: boolean;
  /** Catalog id of the agent this front is opened for, or `null` for none. */
  agentId?: string | null;
  prompt?: string;
}

/** What the app knows and git cannot. */
export interface PlanWorld {
  /** Names already answered to by a group or front of this project. */
  takenNames: readonly string[];
  /** `rootKey(path)` → the front that already works there. */
  ownedPaths: Readonly<Record<string, string>>;
  /** `rootKey(path)` → how many agents are alive in it right now. */
  busyPaths: Readonly<Record<string, number>>;
  /** Agent ids that can actually be launched on this machine. */
  availableAgents: readonly string[];
}

export interface PlannedItem {
  clientItemId: string;
  kind: TargetKind;
  action: PlanAction;
  displayName: string;
  branch: string | null;
  /** The base frozen as a ref *and* a commit, or `null` when none is grown. */
  base: { ref: string; oid: string } | null;
  path: string;
  errors: ProvisionIssue[];
  warnings: ProvisionIssue[];
  agentId: string | null;
  prompt: string;
}

export interface Plan {
  planId: string;
  revision: number;
  createdAt: number;
  expiresAt: number;
  /** Not one row is blocked. */
  valid: boolean;
  isRepo: boolean;
  /** The repository's state when this was built — see `worldFingerprint`. */
  fingerprint: string;
  items: PlannedItem[];
}

/**
 * How long a plan is allowed to stand.
 *
 * Long enough to read it and click, short enough that a `git pull` in another
 * window does not slip underneath. Expiry is the cheap half of the defence;
 * the fingerprint is the half that actually notices.
 */
export const PLAN_TTL_MS = 2 * 60 * 1000;

export interface BuildPlanInput {
  planId: string;
  revision: number;
  now: number;
  specs: readonly TargetSpec[];
  preflight: Preflight;
  world: PlanWorld;
}

/**
 * The repository's state, boiled down to one string.
 *
 * Two plans built over the same fingerprint would create the same things. The
 * moment a branch appears, a worktree is added or the ground moves, the
 * string changes and a plan built before that must not be executed. The
 * listing is sorted first: git is free to change the order it prints, and a
 * plan invalidated by a re-ordering is a plan nobody trusts.
 */
export function worldFingerprint(pf: Preflight): string {
  const worktrees = pf.worktrees
    .map((w) => `${rootKey(w.path)}|${w.branch ?? ""}|${w.bare ? "b" : ""}`)
    .sort()
    .join("~");
  const branches = [...pf.localBranches].sort().join(",");
  return [
    pf.isRepo ? "git" : "plain",
    pf.hasHead ? "head" : "empty",
    pf.groundBranch ?? "",
    branches,
    worktrees,
  ].join("§");
}

export function planIsStale(plan: Plan, now: number): boolean {
  return now > plan.expiresAt;
}

/** The `kind` the backend's preflight understands, per target. */
export function preflightKindOf(kind: TargetKind): string {
  switch (kind) {
    case "new_worktree_new_branch":
      return "new_branch";
    case "new_worktree_existing_branch":
      return "existing_branch";
    case "existing_worktree":
      return "adopt";
    case "current_workspace":
      return "ground";
  }
}

const norm = (s: string): string => s.trim().toLocaleLowerCase("pt-BR");

/** Every row, resolved and judged, plus the collisions between them. */
export function buildPlan(input: BuildPlanInput): Plan {
  const { preflight: pf, world } = input;
  const byId = new Map(pf.items.map((r) => [r.id, r]));

  const items = input.specs.map((spec) =>
    judge(spec, byId.get(spec.clientItemId), pf, world),
  );
  collide(items);

  return {
    planId: input.planId,
    revision: input.revision,
    createdAt: input.now,
    expiresAt: input.now + PLAN_TTL_MS,
    isRepo: pf.isRepo,
    fingerprint: worldFingerprint(pf),
    valid: items.every((i) => i.errors.length === 0),
    items,
  };
}

function judge(
  spec: TargetSpec,
  git: PreflightItemResult | undefined,
  pf: Preflight,
  world: PlanWorld,
): PlannedItem {
  const found: ProvisionIssue[] = [];
  const name = spec.displayName.trim();

  // A project with no git grows no branches: the front becomes a group in the
  // ground's own folder, which is a real answer and not a failure — as long
  // as it is said before the click and not after. Asking for that on purpose
  // (`--no-git`) lands in the same place, and the preflight's `.yard/floors/…`
  // guess for the row has to be thrown away with it: that folder is one
  // nothing will ever create, and the setup hook would be sent to it.
  const plain = !pf.isRepo || spec.noGit === true;
  const path = plain ? pf.groundPath : (git?.path ?? "");
  const key = path ? rootKey(path) : "";

  const action: PlanAction = plain
    ? "create_folder"
    : spec.kind === "existing_worktree"
      ? "adopt_worktree"
      : spec.kind === "current_workspace"
        ? "use_ground"
        : "create_worktree";

  // --- identity ------------------------------------------------------------
  // The ground is named after the branch checked out in it — there is nothing
  // to type, and asking would be asking for a name the app then ignores.
  if (action !== "use_ground") {
    if (!name) {
      found.push(issue("NAME_REQUIRED"));
    } else if (world.takenNames.some((n) => norm(n) === norm(name))) {
      found.push(issue("NAME_TAKEN", { name }));
    }
  }

  if (spec.agentId && !world.availableAgents.includes(spec.agentId)) {
    found.push(issue("AGENT_UNAVAILABLE", { agent: spec.agentId }));
  }

  // --- git -----------------------------------------------------------------
  if (!plain && !pf.hasHead) {
    // Nothing can be branched off nothing; every kind below needs a commit.
    found.push(issue("REPO_WITHOUT_COMMIT"));
  } else if (!plain) {
    switch (spec.kind) {
      case "new_worktree_new_branch": {
        if (git?.branchError) {
          found.push(issue("BRANCH_INVALID", { branch: git.branch ?? "" }));
        } else if (git?.branchExists) {
          found.push(issue("BRANCH_ALREADY_EXISTS", { branch: git.branch ?? "" }));
        }
        if (!git?.baseOid) {
          found.push(issue("BASE_UNRESOLVED", { base: git?.baseRef ?? spec.baseRef ?? "HEAD" }));
        }
        if (git?.pathExists) found.push(issue("WORKTREE_PATH_CONFLICT", { path }));
        break;
      }
      case "new_worktree_existing_branch": {
        if (!spec.branchName?.trim()) {
          found.push(issue("BRANCH_REQUIRED"));
        } else if (!git?.branchExists) {
          found.push(issue("BRANCH_MISSING", { branch: spec.branchName.trim() }));
        } else if (git.branchCheckedOutAt) {
          // Named, not forwarded: git's own sentence points at a path, and
          // the person is looking at a list of branches.
          found.push(
            issue("BRANCH_ALREADY_CHECKED_OUT", {
              branch: git.branch ?? spec.branchName.trim(),
              path: git.branchCheckedOutAt,
            }),
          );
        }
        if (git?.pathExists) found.push(issue("WORKTREE_PATH_CONFLICT", { path }));
        break;
      }
      case "existing_worktree": {
        if (!spec.worktreePath?.trim()) {
          found.push(issue("WORKTREE_REQUIRED"));
        } else if (!git?.pathExists) {
          found.push(issue("WORKTREE_MISSING", { path }));
        } else {
          const owner = world.ownedPaths[key];
          if (owner) found.push(issue("WORKTREE_ADOPTED", { name: owner }));
          if (git.locked !== null && git.locked !== undefined) {
            found.push(issue("WORKTREE_LOCKED", { reason: git.locked || "sem motivo" }));
          }
          if (git.dirty) found.push(issue("WORKTREE_DIRTY"));
        }
        break;
      }
      case "current_workspace": {
        // Nothing is created and the branch is never swapped — §3.1. What is
        // owed here is the warning: this is the copy the person has open.
        found.push(issue("GROUND_IN_USE"));
        if (git?.dirty) found.push(issue("WORKTREE_DIRTY"));
        break;
      }
    }
    // An agent already alive in the destination is the sharing the plan
    // insists on saying out loud: inside one folder git isolates nothing.
    if (
      (action === "adopt_worktree" || action === "use_ground") &&
      (world.busyPaths[key] ?? 0) > 0
    ) {
      found.push(issue("WORKTREE_SHARED"));
    }
  }

  // Said only when the folder *cannot* have git. Somebody who chose `--no-git`
  // already knows, and a warning that repeats a choice back is noise.
  if (!pf.isRepo) found.push(issue("NOT_A_REPO"));

  return {
    clientItemId: spec.clientItemId,
    kind: spec.kind,
    action,
    displayName: action === "use_ground" ? (git?.branch ?? name) : name,
    branch: plain ? null : (git?.branch ?? null),
    base:
      git?.baseRef && git.baseOid ? { ref: git.baseRef, oid: git.baseOid } : null,
    path,
    errors: blockers(found),
    warnings: notices(found),
    agentId: spec.agentId ?? null,
    prompt: spec.prompt ?? "",
  };
}

/**
 * What no single row can see: the rows beside it.
 *
 * Both sides of a clash are marked, never just the second one — the person
 * has to see which two rows are fighting, and "row 4 is invalid" with row 1
 * looking innocent sends them to change the wrong one.
 */
function collide(items: PlannedItem[]): void {
  const bucket = <T>(pick: (i: PlannedItem) => T | null): Map<T, PlannedItem[]> => {
    const map = new Map<T, PlannedItem[]>();
    for (const item of items) {
      const k = pick(item);
      if (k === null) continue;
      const list = map.get(k);
      if (list) list.push(item);
      else map.set(k, [item]);
    }
    return map;
  };

  const creates = (i: PlannedItem) => i.action === "create_worktree";

  for (const [name, rows] of bucket((i) =>
    i.action === "use_ground" || !i.displayName ? null : norm(i.displayName),
  )) {
    if (rows.length > 1) {
      for (const r of rows) r.errors.push(issue("ITEM_NAME_COLLISION", { name }));
    }
  }

  // Only the rows that would *create* a branch or a folder can collide over
  // one: two rows adopting the same worktree share a branch on purpose, and
  // that is the warning below, not an error.
  for (const [branch, rows] of bucket((i) => (creates(i) ? i.branch : null))) {
    if (rows.length > 1) {
      for (const r of rows) r.errors.push(issue("ITEM_BRANCH_COLLISION", { branch }));
    }
  }

  for (const [path, rows] of bucket((i) => (creates(i) && i.path ? rootKey(i.path) : null))) {
    if (rows.length > 1) {
      for (const r of rows) r.errors.push(issue("ITEM_PATH_COLLISION", { path }));
    }
  }

  for (const [, rows] of bucket((i) =>
    !creates(i) && i.path ? rootKey(i.path) : null,
  )) {
    if (rows.length > 1) {
      for (const r of rows) {
        if (!r.warnings.some((w) => w.code === "WORKTREE_SHARED")) {
          r.warnings.push(issue("WORKTREE_SHARED"));
        }
      }
    }
  }
}
