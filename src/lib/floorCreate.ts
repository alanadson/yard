/**
 * Opening one front, for the callers that have no screen to put a plan on.
 *
 * This used to be the *other* way of opening a front: it called
 * `worktree_provision` straight, carried a hand-written copy of two of the
 * dialog's checks (the name, the worktree somebody already adopted) and none
 * of the rest, and rolled back with `git branch -D`, which deletes whatever
 * is on the branch, including a commit an agent made a second ago.
 *
 * Now it is a shim: one request, through `provisionFronts`, which is the same
 * road the dialog takes. The preflight, the collisions, the base frozen as a
 * commit and the journal that only undoes what it wrote come along for free,
 * and `yard floor create`, "Nova aba" and the fan-out stop being able to walk
 * past a refusal the dialog would have shown.
 *
 * What it keeps is its shape: one front in, `{ groupId, provision }` out, and
 * a refusal is a thrown `Error` with the sentence already translated.
 */
import { type FloorHooks, type FloorTask } from "./floors";
import { t } from "./i18n";
import { issueText } from "./provision/errors";
import {
  firstProblem,
  placementOf,
  provisionFronts,
  type FloorPlacement,
} from "./provision/run";

export interface CreateFloorInput {
  projectId: string;
  name: string;
  branch?: string;
  existingBranch?: boolean;
  /**
   * A worktree that is already on the disk (`git worktree list` said so),
   * which the front only adopts. Nothing is created, so nothing is rolled back
   * either: closing such a front removes a folder git made before the Yard
   * ever saw this project.
   */
  adopt?: { path: string; branch?: string | null };
  noGit?: boolean;
  copyGround?: boolean;
  hooks?: FloorHooks;
  /** `false` = do not switch the active group (CLI / fan-out). */
  activate?: boolean;
  task?: FloorTask;
  agentId?: string;
}

export interface CreatedFloor {
  groupId: string;
  /**
   * Where the front landed. The two OIDs the old receipt carried are gone on
   * purpose: they belong to the journal now, which is what owns the rollback
   * and the only thing allowed to act on them.
   */
  provision: FloorPlacement;
}

export async function createFloor(input: CreateFloorInput): Promise<CreatedFloor> {
  const run = await provisionFronts({
    projectId: input.projectId,
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.copyGround !== undefined ? { copyGround: input.copyGround } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.activate !== undefined ? { activate: input.activate } : {}),
    // The agent is written onto the floor and not started here. The one
    // caller that passes it (the fan-out) launches the CLI itself, because
    // it needs the terminal id back.
    launchAgents: false,
    fronts: [
      {
        id: "front",
        kind: input.adopt
          ? "existing_worktree"
          : input.existingBranch
            ? "new_worktree_existing_branch"
            : "new_worktree_new_branch",
        name: input.name,
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.adopt ? { worktreePath: input.adopt.path } : {}),
        ...(input.noGit ? { noGit: true } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
      },
    ],
  });

  const problem = firstProblem(run);
  if (problem) throw new Error(issueText(problem));

  const groupId = run.report?.items[0]?.groupId;
  const provision = placementOf(run);
  if (!groupId || !provision) throw new Error(t("não consegui abrir a frente"));
  return { groupId, provision };
}
