/**
 * Pure model of floors: a project group that works on an isolated copy of
 * the repository (`git worktree`), with its own canvas.
 *
 * The metadata travels inside the group's `layout_json` (`layout.floor`) —
 * no new table. Golden rule: a field `parseLayout` does not copy vanishes
 * on the next save, so the validation lives here, pure and testable.
 *
 * Convention: the project's `sort === 0` group is the **ground**. A group
 * without `floor` is treated as ground — regular groups created by hand
 * keep working as they always did.
 */

export type FloorKind = "ground" | "isolated" | "plain";

export interface FloorHooks {
  /** Commands run when the floor is created (if `autoSetup`). */
  setup: string[];
  /** Commands behind the ▶ button in the floors overview. */
  run: string[];
  /** Commands run before the floor is closed. */
  teardown: string[];
  autoSetup?: boolean;
}

export interface FloorMeta {
  kind: FloorKind;
  /** The worktree's branch (`isolated`). */
  branch?: string;
  /** Worktree root; absent for `ground`/`plain` (they use the project path). */
  worktreePath?: string;
  hooks?: FloorHooks;
}

/** Implicit ground of any group without floor metadata. */
export const GROUND_FLOOR: FloorMeta = { kind: "ground" };

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === "string" && c.trim() !== "")
    : [];
}

/**
 * Validates what came from the persisted JSON. A crooked field does not
 * bring down the boot: an invalid `floor` simply disappears (the group
 * becomes regular again).
 */
export function normalizeFloor(raw: unknown): FloorMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<FloorMeta>;
  if (r.kind !== "ground" && r.kind !== "isolated" && r.kind !== "plain") {
    return undefined;
  }
  const floor: FloorMeta = { kind: r.kind };
  if (typeof r.branch === "string" && r.branch.trim()) floor.branch = r.branch;
  if (typeof r.worktreePath === "string" && r.worktreePath.trim()) {
    floor.worktreePath = r.worktreePath;
  }
  if (r.hooks && typeof r.hooks === "object") {
    const h = r.hooks as Partial<FloorHooks>;
    const hooks: FloorHooks = {
      setup: stringList(h.setup),
      run: stringList(h.run),
      teardown: stringList(h.teardown),
    };
    if (typeof h.autoSetup === "boolean") hooks.autoSetup = h.autoSetup;
    if (hooks.setup.length || hooks.run.length || hooks.teardown.length) {
      floor.hooks = hooks;
    }
  }
  return floor;
}

/**
 * Environment for floor hooks, in the shape `floor_run_hook` expects.
 * Same names as documented in the spec: the script knows where the worktree
 * is, where the ground is, and which branch is its own.
 */
export function floorHookEnv(input: {
  floorName: string;
  branch?: string;
  floorPath: string;
  rootPath: string;
  projectName: string;
}): [string, string][] {
  return [
    ["YARD_FLOOR_NAME", input.floorName],
    ["YARD_BRANCH_NAME", input.branch ?? ""],
    ["YARD_FLOOR_PATH", input.floorPath],
    ["YARD_ROOT_PATH", input.rootPath],
    ["YARD_PROJECT_NAME", input.projectName],
  ];
}

/** Hooks textarea (one command per line) -> clean list. */
export function parseHookLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
