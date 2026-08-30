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

import { t } from "./i18n";

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

/**
 * A task shared by every floor spawned from the same fan-out. Compare
 * groups by `id`; the prompt is what each agent was asked to do.
 */
export interface FloorTask {
  id: string;
  prompt: string;
  createdAt: number;
}

export interface FloorMeta {
  kind: FloorKind;
  /** The worktree's branch (`isolated`). */
  branch?: string;
  /** Worktree root; absent for `ground`/`plain` (they use the project path). */
  worktreePath?: string;
  /**
   * The worktree was already on the disk and this front only adopted it.
   *
   * What the Yard did not create, the Yard does not delete: closing such a
   * front takes the group, the cards and the canvas, and leaves the folder
   * (and the branch) exactly as they were.
   */
  adopted?: boolean;
  hooks?: FloorHooks;
  /** Present on floors created by "Nova tarefa" / `yard floor fanout`. */
  task?: FloorTask;
  /** Agent catalog id this floor was opened for (fan-out). */
  agentId?: string;
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
  if (r.adopted === true) floor.adopted = true;
  if (typeof r.agentId === "string" && r.agentId.trim()) floor.agentId = r.agentId;
  if (r.task && typeof r.task === "object") {
    const t = r.task as Partial<FloorTask>;
    if (
      typeof t.id === "string" &&
      t.id.trim() &&
      typeof t.prompt === "string" &&
      typeof t.createdAt === "number"
    ) {
      floor.task = { id: t.id, prompt: t.prompt, createdAt: t.createdAt };
    }
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

/**
 * A group of the project whose name matches, ignoring case and surrounding
 * space — the rule both the "Abrir frente" dialog and `yard floor create` use
 * to refuse a duplicate.
 *
 * It lives here because the two used to disagree: the CLI checked, the dialog
 * did not. With git that mostly hid behind a slug collision in the backend,
 * but a floor created with "sem git" skips provisioning entirely, so two
 * groups could end up with the same name in the same project — and after that
 * `yard floor list`, `recruit --floor` and this very lookup all resolve to
 * whichever one happens to sort first.
 *
 * Takes the group list instead of reading the store so it stays pure.
 */
export function findGroupNamed<T extends { name: string }>(
  groups: readonly T[],
  name: string,
): T | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  return groups.find((g) => g.name.trim().toLowerCase() === target) ?? null;
}

/**
 * `"Fix login · Claude"`; if that name is taken, `"Fix login · Claude (2)"`.
 * Fan-out and the dialog share this so a second run of the same task does
 * not collide with the first.
 */
export function uniqueFloorName(
  groups: readonly { name: string }[],
  base: string,
): string {
  const trimmed = base.trim() || t("Frente");
  if (!findGroupNamed(groups, trimmed)) return trimmed;
  let n = 2;
  while (findGroupNamed(groups, `${trimmed} (${n})`)) {
    n += 1;
    if (n > 99) return `${trimmed} (${Date.now() % 10_000})`;
  }
  return `${trimmed} (${n})`;
}

export function isIsolatedFloor(floor: FloorMeta | undefined): boolean {
  return floor?.kind === "isolated" && !!floor.branch;
}

/**
 * Whether a group's name belongs to git rather than to the user.
 *
 * Only the ground of a project with a repository: it is the project root, the
 * root is on a branch, and the branch is the name. Renaming it in the tree
 * would be a lie in both directions, the label drifting off the branch while
 * the branch stays put, so the row does not offer it. `git branch -m`, in
 * Controle, is the one way to change it.
 */
export function isBranchNamed(
  floor: FloorMeta,
  groundBranch: string | null | undefined,
): boolean {
  return floor.kind === "ground" && !!groundBranch?.trim();
}

/**
 * What a row prints for a group: the branch for the ground, the stored name
 * for everyone else (a front is named after its task, with its branch beside
 * it; a folder-group of before keeps whatever it was called).
 */
export function groupLabel(input: {
  name: string;
  floor: FloorMeta;
  groundBranch?: string | null;
}): string {
  if (isBranchNamed(input.floor, input.groundBranch)) return input.groundBranch!.trim();
  return input.name.trim() || t("Sem nome");
}
