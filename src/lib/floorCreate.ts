/**
 * Creating a floor: provision the worktree, then the group. Shared by the
 * "Criar andar" dialog, `yard floor create` and fan-out — the three used to
 * diverge on clone-ground, rollback and the name-uniqueness check.
 *
 * Provisioning hits the disk before anything exists in the store, so a
 * failure in between used to leave a real worktree (and a real branch) with
 * no floor pointing at them. The rollback here is the same one the dialog
 * already had.
 */
import { ipc, type WorktreeProvision } from "./ipc";
import {
  findGroupNamed,
  type FloorHooks,
  type FloorMeta,
  type FloorTask,
} from "./floors";
import { applyScore, serializeGroup } from "./scores";
import { useProjects } from "../stores/projectsStore";

export interface CreateFloorInput {
  projectId: string;
  name: string;
  branch?: string;
  existingBranch?: boolean;
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
  provision: WorktreeProvision;
}

export async function createFloor(input: CreateFloorInput): Promise<CreatedFloor> {
  const s = useProjects.getState();
  const project = s.projects.find((p) => p.id === input.projectId);
  if (!project) throw new Error("projeto não encontrado");
  const name = input.name.trim();
  if (!name) throw new Error("dê um nome ao andar");
  const duplicates = findGroupNamed(s.groupsOf(project.id), name);
  if (duplicates) {
    throw new Error(`já existe um grupo/andar chamado "${duplicates.name}" neste projeto`);
  }
  if (input.existingBranch && !input.branch?.trim()) {
    throw new Error("uma branch existente exige o nome dela");
  }

  let provisioned: { path: string; branch: string | null } | null = null;
  try {
    const provision = await ipc.worktreeProvision({
      projectPath: project.path,
      name,
      branch: input.branch?.trim() || null,
      existingBranch: !!input.existingBranch,
      noGit: !!input.noGit,
    });
    if (provision.kind === "isolated") {
      provisioned = {
        path: provision.path,
        branch: input.existingBranch ? null : (provision.branch ?? null),
      };
    }

    const hooks = input.hooks;
    const hasHooks =
      !!hooks &&
      (hooks.setup.length || hooks.run.length || hooks.teardown.length);
    const floor: FloorMeta =
      provision.kind === "isolated"
        ? {
            kind: "isolated",
            branch: provision.branch ?? undefined,
            worktreePath: provision.path,
            ...(hasHooks && hooks ? { hooks } : {}),
            ...(input.task ? { task: input.task } : {}),
            ...(input.agentId ? { agentId: input.agentId } : {}),
          }
        : {
            kind: "plain",
            ...(hasHooks && hooks ? { hooks } : {}),
            ...(input.task ? { task: input.task } : {}),
            ...(input.agentId ? { agentId: input.agentId } : {}),
          };

    const groupId = s.addGroup(project.id, name, {
      activate: input.activate,
      layout: { floor },
    });

    if (input.copyGround) {
      const ground = s
        .groupsOf(project.id)
        .filter((g) => g.id !== groupId)
        .sort((a, b) => a.sort - b.sort)[0];
      if (ground) {
        applyScore(serializeGroup(ground.id, name), groupId, {
          cwd: provision.kind === "isolated" ? provision.path : project.path,
        });
      }
    }

    return { groupId, provision };
  } catch (e) {
    if (provisioned) {
      try {
        await ipc.worktreeRemove(
          project.path,
          provisioned.path,
          provisioned.branch,
        );
      } catch {
        throw new Error(
          `${e}. O worktree em ${provisioned.path} ficou para trás — apague-o com \`git worktree remove\`.`,
        );
      }
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}
