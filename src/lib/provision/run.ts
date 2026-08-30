/**
 * The one door: a request for fronts goes in, a plan and a report come out.
 *
 * The dialog got all of this first: the preflight, the collisions between
 * rows, the base frozen as a commit, the journal that knows what it wrote and
 * therefore what it may undo. Everything else that opens a front (`yard floor
 * create`, "Nova aba" adopting a worktree, the fan-out) called
 * `worktree_provision` directly, carrying a hand-written copy of two of those
 * checks and none of the others. Three surfaces, three sets of rules, and the
 * two that were not the dialog rolled back with `git branch -D`.
 *
 * So there is no second way in any more. `createFloor` is a shim over this,
 * the dialog is this with a screen attached, and the guarantees (nothing is
 * created on a base nobody approved, nothing is deleted that this operation
 * created on a base nobody approved, nothing deleted that this operation did
 * not write) belong to every caller instead of to one.
 *
 * Two things are worth reading twice:
 *
 * - **A plan that is not valid never reaches the effects.** Not "the caller
 *   should check": the run itself refuses, which is what makes it safe to
 *   hand this to a CLI whose caller is a shell script.
 * - **`dryRun` is a read.** The backend's preflight writes nothing, so a
 *   `--dry-run` leaves the repository exactly as it found it, and that is
 *   what `yard floor create --dry-run` promises.
 */
import { nanoid } from "nanoid";

import { pickableAgents } from "../agentDefaults";
import type { FloorHooks, FloorTask } from "../floors";
import { ipc } from "../ipc";
import { t } from "../i18n";
import { useAgentDefaults } from "../../stores/agentDefaultsStore";
import { useProjects } from "../../stores/projectsStore";
import {
  runBatch,
  type BatchReport,
  type FailurePolicy,
  type ProvisionEffects,
  type SetupPolicy,
} from "./batch";
import { yardEffects } from "./effects";
import type { ProvisionIssue } from "./errors";
import { buildPlan, type Plan, type TargetKind, type TargetSpec } from "./plan";
import { specsToPreflight, worldFrom } from "./world";

/** One front somebody asked for, in the words of the caller rather than git. */
export interface FrontRequest {
  /** Stable across a retry. Defaults to the row's position. */
  id?: string;
  /** Defaults to the common case: a branch of its own, off the default base. */
  kind?: TargetKind;
  name: string;
  branch?: string;
  worktreeName?: string;
  baseRef?: string;
  /** The worktree to adopt, for `existing_worktree`. */
  worktreePath?: string;
  /** Share the ground's folder even in a repository: `--no-git`. */
  noGit?: boolean;
  agentId?: string | null;
  prompt?: string;
}

export interface ProvisionRunInput {
  projectId: string;
  fronts: readonly FrontRequest[];
  hooks?: FloorHooks;
  copyGround?: boolean;
  task?: FloorTask;
  /** Switch the app to the front that was born. The CLI and fan-out do not. */
  activate?: boolean;
  /**
   * Whether a row that names an agent should also *start* it.
   *
   * `false` for the callers that open the front and launch the CLI
   * themselves (the fan-out, which needs the terminal id it created). There
   * the agent is metadata on the floor, and metadata about a binary this
   * machine may not have is not a reason to refuse the front, so the
   * availability check goes with the launch.
   */
  launchAgents?: boolean;
  /** Build the plan, show it, write nothing. */
  dryRun?: boolean;
  policy?: FailurePolicy;
  setupPolicy?: SetupPolicy;
  /** The clock and the ids, as arguments, for the usual reason. */
  now?: () => number;
  newId?: () => string;
  /** Injected by the tests; production builds them from the app's own state. */
  effects?: ProvisionEffects;
  onProgress?: (report: BatchReport) => void;
  cancelled?: () => boolean;
}

export interface ProvisionRun {
  plan: Plan;
  /** `null` when nothing was written: a dry run, or a plan that was refused. */
  report: BatchReport | null;
}

/** Where a front ended up, for the callers that only need the address. */
export interface FloorPlacement {
  path: string;
  branch: string | null;
  /** `isolated` = a git worktree; `plain` = the ground's own folder. */
  kind: "isolated" | "plain";
}

export async function provisionFronts(input: ProvisionRunInput): Promise<ProvisionRun> {
  const store = useProjects.getState();
  const project = store.projects.find((p) => p.id === input.projectId);
  if (!project) throw new Error(t("projeto não encontrado"));

  const now = input.now ?? (() => Date.now());
  const newId = input.newId ?? (() => nanoid(10));

  const specs: TargetSpec[] = input.fronts.map((f, i) => ({
    clientItemId: f.id ?? String(i),
    kind: f.kind ?? "new_worktree_new_branch",
    displayName: f.name,
    ...(f.branch !== undefined ? { branchName: f.branch } : {}),
    ...(f.worktreeName !== undefined ? { worktreeName: f.worktreeName } : {}),
    ...(f.baseRef !== undefined ? { baseRef: f.baseRef } : {}),
    ...(f.worktreePath !== undefined ? { worktreePath: f.worktreePath } : {}),
    ...(f.noGit ? { noGit: true } : {}),
    agentId: f.agentId ?? null,
    prompt: f.prompt ?? "",
  }));

  const preflight = await ipc.worktreePreflight(project.path, specsToPreflight(specs));
  // Only asked for when a row actually names an agent *and* something is
  // going to start it: detecting agents shells out to every CLI on the
  // machine, and a `yard floor create` with no agent must not pay for that.
  const launching = input.launchAgents !== false;
  const wanted = specs.map((s) => s.agentId).filter((id): id is string => !!id);
  const agents = launching && wanted.length ? await installedAgents() : [];

  const s = useProjects.getState();
  const plan = buildPlan({
    planId: newId(),
    revision: 1,
    now: now(),
    specs,
    preflight,
    world: worldFrom({
      projectId: project.id,
      projectPath: project.path,
      groups: s.groups,
      floorOf: (id) => s.floorOf(id),
      terminals: s.terminals,
      availableAgents: launching ? agents.map((a) => a.id) : wanted,
    }),
  });

  // The gate. A caller that ignores `plan.valid` still cannot write.
  if (input.dryRun || !plan.valid) return { plan, report: null };

  const effects =
    input.effects ??
    yardEffects({
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      ...(input.hooks ? { hooks: input.hooks } : {}),
      ...(input.copyGround !== undefined ? { copyGround: input.copyGround } : {}),
      ...(input.task ? { task: input.task } : {}),
      ...(input.activate !== undefined ? { activate: input.activate } : {}),
      // No binary, no launch: this is how `launchAgents: false` is enforced
      // at the boundary rather than trusted to a flag somebody may forget.
      agentBin: (id) => (launching ? (agents.find((a) => a.id === id)?.bin ?? null) : null),
      agentName: (id) => agents.find((a) => a.id === id)?.name ?? id,
    });

  const report = await runBatch({
    plan,
    effects,
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.setupPolicy ? { setupPolicy: input.setupPolicy } : {}),
    now,
    ...(input.cancelled ? { cancelled: input.cancelled } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  return { plan, report };
}

/**
 * The first thing that went wrong, wherever it went wrong.
 *
 * A refusal before anything was written and a failure halfway through are two
 * different events, and the callers that only have a return value to give
 * (`createFloor`, the CLI) need one answer for both. `null` means every row
 * came out the other side.
 */
export function firstProblem(run: ProvisionRun): ProvisionIssue | null {
  for (const item of run.plan.items) {
    if (item.errors.length) return item.errors[0];
  }
  for (const item of run.report?.items ?? []) {
    if (item.issue) return item.issue;
  }
  return null;
}

/** Where the front described by one row of a finished run actually landed. */
export function placementOf(run: ProvisionRun, index = 0): FloorPlacement | null {
  const planned = run.plan.items[index];
  const reported = run.report?.items[index];
  if (!planned || !reported) return null;
  return {
    path: reported.path ?? planned.path,
    branch: reported.branch ?? planned.branch,
    kind: planned.action === "create_folder" ? "plain" : "isolated",
  };
}

async function installedAgents(): Promise<{ id: string; name: string; bin: string | null }[]> {
  const detected = await ipc.detectAgents(false).catch(() => []);
  return pickableAgents(
    detected.filter((a) => a.installed && a.bin),
    useAgentDefaults.getState().defaults,
  );
}
