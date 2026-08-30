/**
 * The plan, said out loud to somebody who has no dialog.
 *
 * `yard floor create --dry-run` and `--json` exist for the same reason the
 * dialog's preview does: the click is split in two, and the half that decides
 * has to be readable before the half that writes runs. A CLI that only
 * answered "pronto" or a raw git error would be the old dialog again, with
 * fewer pixels.
 *
 * Two audiences, two shapes, and the difference is deliberate:
 *
 * - **The person** gets four lines per front (the verb, the commit, the
 *   branch, the folder) with a refusal printed *under the row that caused
 *   it*. A list of rows followed by a paragraph of errors makes the reader do
 *   the join, and with twelve rows they get it wrong.
 * - **The script** gets codes. `BRANCH_ALREADY_CHECKED_OUT` survives a
 *   rewrite of the sentence beside it; a `grep` for a Portuguese phrase does
 *   not. The sentence rides along anyway, for whoever prints it.
 *
 * Pure, so both are testable with no repository, and shared by the CLI and by
 * anything else that has to explain a plan without drawing one.
 */
import { issueText, type ProvisionCode, type ProvisionIssue } from "./errors";
import type { BatchState, ItemState } from "./batch";
import type { PlanAction, PlannedItem } from "./plan";
import type { ProvisionRun } from "./run";

/** The verb of each row, in the words the plan uses on screen. */
const VERB: Record<PlanAction, string> = {
  create_worktree: "criar worktree",
  adopt_worktree: "adotar worktree existente",
  use_ground: "usar o chão do projeto",
  create_folder: "abrir sem git, na pasta do chão",
};

/** A commit is a commit; forty characters of it in a terminal are noise. */
const short = (oid: string): string => oid.slice(0, 7);

function baseOf(item: PlannedItem): string {
  return item.base ? `${item.base.ref} @ ${short(item.base.oid)}` : "nenhuma";
}

export interface PlanTextOptions {
  project: string;
  /** Already ran? Then the header must not promise that nothing was written. */
  written?: boolean;
}

export function planText(
  plan: ProvisionRun["plan"],
  opts: PlanTextOptions,
): string {
  const head = opts.written
    ? `Plano de "${opts.project}":`
    : `Plano de "${opts.project}" (nada foi escrito):`;
  const lines: string[] = [head, ""];

  plan.items.forEach((item, i) => {
    lines.push(`  ${i + 1}. "${item.displayName || "(sem nome)"}"`);
    lines.push(`     ação:   ${VERB[item.action]}`);
    if (item.action === "create_worktree") lines.push(`     base:   ${baseOf(item)}`);
    if (item.branch) lines.push(`     branch: ${item.branch}`);
    lines.push(`     pasta:  ${item.path}`);
    for (const e of item.errors) lines.push(`     erro:   ${issueText(e)}`);
    for (const w of item.warnings) lines.push(`     aviso:  ${issueText(w)}`);
    lines.push("");
  });

  lines.push(`  ${countsOf(plan.items)}`);
  return `${lines.join("\n")}\n`;
}

/** What is about to be written, not how many rows there are. */
function countsOf(items: readonly PlannedItem[]): string {
  const worktrees = items.filter((i) => i.action === "create_worktree").length;
  const adopted = items.filter((i) => i.action === "adopt_worktree").length;
  const agents = items.filter((i) => !!i.agentId).length;
  const parts = [
    `${worktrees} worktree(s) nova(s)`,
    ...(adopted ? [`${adopted} adotado(s)`] : []),
    `${agents} agente(s)`,
  ];
  return parts.join(", ") + ".";
}

/** One refusal, in both currencies: the stable one and the readable one. */
export interface JsonIssue {
  code: ProvisionCode;
  message: string;
}

export interface JsonItem {
  id: string;
  name: string;
  action: PlanAction;
  branch: string | null;
  base: { ref: string; oid: string } | null;
  path: string;
  /** `planned` until something ran, then whatever the batch reported. */
  state: ItemState | "planned";
  groupId: string | null;
  errors: JsonIssue[];
  warnings: JsonIssue[];
}

export interface JsonRun {
  /** Every row came up. A partial result is **not** ok; see the exit codes. */
  ok: boolean;
  planId: string;
  state: BatchState | "planned";
  items: JsonItem[];
}

const jsonIssue = (i: ProvisionIssue): JsonIssue => ({ code: i.code, message: issueText(i) });

export function runJson(run: ProvisionRun): JsonRun {
  const byId = new Map((run.report?.items ?? []).map((r) => [r.clientItemId, r]));

  const items: JsonItem[] = run.plan.items.map((item) => {
    const done = byId.get(item.clientItemId);
    return {
      id: item.clientItemId,
      name: item.displayName,
      action: item.action,
      branch: done?.branch ?? item.branch,
      base: item.base,
      path: done?.path ?? item.path,
      state: done?.state ?? "planned",
      groupId: done?.groupId ?? null,
      errors: [...item.errors, ...(done?.issue ? [done.issue] : [])].map(jsonIssue),
      warnings: item.warnings.map(jsonIssue),
    };
  });

  return {
    ok: run.report?.state === "succeeded",
    planId: run.plan.planId,
    state: run.report?.state ?? "planned",
    items,
  };
}

/**
 * The line printed after a run that actually wrote something.
 *
 * A row that ends in `cleanup_required` is the one that must never be
 * summarised away: something this operation made is still on the disk and
 * only a person can decide what to do with it.
 */
export function runSummary(run: ProvisionRun): string {
  const items = run.report?.items ?? [];
  const ready = items.filter((i) => i.state === "ready");
  const stuck = items.filter((i) => i.state === "cleanup_required");
  const failed = items.filter((i) => i.state === "failed" || i.state === "rolled_back");

  const lines: string[] = [];
  for (const item of ready) {
    lines.push(
      `Frente "${item.displayName}" aberta` +
        (item.branch ? `: branch ${item.branch}` : "") +
        (item.path ? `, em ${item.path}` : "") +
        ".",
    );
  }
  for (const item of failed) {
    lines.push(
      `Frente "${item.displayName}" não subiu` +
        (item.issue ? `: ${issueText(item.issue)}` : ".") ,
    );
  }
  for (const item of stuck) {
    lines.push(
      `Frente "${item.displayName}" precisa de limpeza à mão` +
        (item.issue ? `: ${issueText(item.issue)}` : "") +
        `. Veja \`git worktree list\`.`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * The number the shell reads, from §11.3 of the design.
 *
 * The distinction worth the extra codes is between "some of it worked" and
 * "something this run made is still on the disk". A pipeline that flattens
 * the second into the first carries on over a leftover worktree, and nobody
 * finds it until `git worktree list` a week later.
 *
 * - `0` every row came up, or nothing was asked to run and nothing refused
 * - `1` it ran and no row came up
 * - `2` the plan was refused: nothing was written
 * - `3` partial: some fronts exist, some do not
 * - `4` a compensation could not finish and a person is owed a look
 * - `5` cancelled
 */
export function exitCodeOf(run: ProvisionRun): number {
  if (!run.report) return run.plan.valid ? 0 : 2;
  switch (run.report.state) {
    case "succeeded":
      return 0;
    case "partially_succeeded":
      return 3;
    case "cleanup_required":
      return 4;
    case "cancelled":
      return 5;
    case "failed":
      return 1;
  }
}
