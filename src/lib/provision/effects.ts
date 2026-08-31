/**
 * The boundary. Above it, `batch.ts` decides; here, things are written.
 *
 * Every method is deliberately dumb — one call each, no branching that could
 * disagree with the plan. That is the point: the rules were already decided
 * and tested with none of this attached, and anything clever added here is a
 * second opinion that will eventually contradict the first.
 *
 * Two lines are worth reading twice:
 *
 * - `createWorktree` forwards the plan's **base** and **folder**. Without
 *   them git would derive both again, from HEAD and from the slug, and the
 *   disk would quietly get something other than the screen promised.
 * - `removeWorktree` passes `null` where the branch to delete goes. The
 *   branch is deleted separately, through a compare-and-swap, because
 *   `git branch -D` takes whatever is on it — and by then that may be a
 *   commit an agent made a second ago.
 */
import { ipc } from "../ipc";
import { floorHookEnv, type FloorHooks, type FloorMeta, type FloorTask } from "../floors";
import { runFloorHooks } from "../floorHooks";
import { closeTerminal, startTerminalProcess } from "../lifecycle";
import { deliverBriefing } from "../roleBrief";
import { roleLaunch } from "../roles";
import { cloneGroundInto } from "../groundClone";
import { defaultRoleOf, titleFor } from "../agentDefaults";
import { useAgentDefaults } from "../../stores/agentDefaultsStore";
import { useProjects } from "../../stores/projectsStore";
import type { ProvisionEffects, Provisioned } from "./batch";
import type { PlannedItem } from "./plan";

export interface EffectsInput {
  projectId: string;
  projectPath: string;
  projectName?: string;
  /** Commands to run in each new front, and whether to run them at all. */
  hooks?: FloorHooks;
  /** Clone the ground's layout into the new front, terminals stopped. */
  copyGround?: boolean;
  /**
   * Switch the app to the front that was born. The dialog and the CLI both
   * say no: a batch of four would leave the screen on whichever row happened
   * to finish last, and the CLI must never move the user's view at all.
   */
  activate?: boolean;
  /** The shared task, when this batch came from one prompt. */
  task?: FloorTask;
  /** Where an agent's binary is, by catalog id. `null` = do not launch. */
  agentBin?: (agentId: string) => string | null;
  /** Human name of the agent, for the tab's title. */
  agentName?: (agentId: string) => string;
}

export function yardEffects(input: EffectsInput): ProvisionEffects {
  const store = () => useProjects.getState();
  const groundOf = () =>
    [...store().groupsOf(input.projectId)].sort((a, b) => a.sort - b.sort)[0];

  return {
    refresh: async () => ipc.worktreePreflight(input.projectPath, []),

    createWorktree: async (item: PlannedItem): Promise<Provisioned> => {
      const existing = item.kind === "new_worktree_existing_branch";
      const made = await ipc.worktreeProvision({
        projectPath: input.projectPath,
        name: item.displayName,
        branch: item.branch,
        existingBranch: existing,
        noGit: item.action === "create_folder",
        // The commit the person approved, not whatever HEAD is by now.
        base: existing ? null : (item.base?.oid ?? null),
        // The folder the plan printed, not the slug derived a second time.
        worktreeName: folderOf(item.path),
      });
      return { path: made.path, branch: made.branch, headOid: made.headOid ?? null };
    },

    registerGroup: async (item: PlannedItem, at: Provisioned): Promise<string> => {
      // The ground already exists; a second group over the same folder would
      // be two names for one working copy, which is the thing this whole
      // redesign removed from the app.
      if (item.action === "use_ground") {
        const ground = groundOf();
        if (ground) return ground.id;
      }
      const isolated = item.action !== "create_folder";
      const floor: FloorMeta = isolated
        ? {
            kind: "isolated",
            branch: at.branch ?? undefined,
            worktreePath: at.path,
            // What the Yard did not create, the Yard never deletes.
            ...(item.action === "adopt_worktree" ? { adopted: true } : {}),
            ...(input.hooks ? { hooks: input.hooks } : {}),
            ...(input.task ? { task: input.task } : {}),
            ...(item.agentId ? { agentId: item.agentId } : {}),
          }
        : {
            kind: "plain",
            ...(input.hooks ? { hooks: input.hooks } : {}),
            ...(input.task ? { task: input.task } : {}),
            ...(item.agentId ? { agentId: item.agentId } : {}),
          };

      const groupId = store().addGroup(input.projectId, item.displayName, {
        activate: input.activate === true,
        layout: { floor },
      });
      if (input.copyGround) {
        const ground = groundOf();
        // The ground's *panes*, not its board. Cloning used to go through a
        // score, and a score landing on an empty group turns it to the
        // canvas — so opening a front dropped the user on a board, with the
        // ground's tabs nowhere in it. The canvas is entered on purpose.
        if (ground && ground.id !== groupId) cloneGroundInto(ground.id, groupId, at.path);
      }
      return groupId;
    },

    runSetup: async (item: PlannedItem, _groupId: string, at: Provisioned): Promise<void> => {
      const setup = input.hooks?.setup ?? [];
      if (!setup.length || input.hooks?.autoSetup === false) return;
      const r = await runFloorHooks(
        at.path,
        setup,
        floorHookEnv({
          floorName: item.displayName,
          branch: at.branch ?? undefined,
          floorPath: at.path,
          rootPath: input.projectPath,
          projectName: input.projectName ?? "",
        }),
      );
      if (!r.ok) throw new Error(r.detail);
    },

    launchAgent: async (item, groupId, at): Promise<string | null> => {
      if (!item.agentId) return null;
      const program = input.agentBin?.(item.agentId) ?? null;
      if (!program) return null;
      const label = input.agentName?.(item.agentId) ?? item.agentId;
      const defaults = useAgentDefaults.getState();
      const pick = defaultRoleOf(defaults.defaults, item.agentId);
      const launch = roleLaunch(item.agentId, pick?.role);
      const born = defaults.launchOf(item.agentId, {
        program,
        args: launch.args,
        cwd: at.path,
      });
      const terminalId = store().addTerminal({
        groupId,
        title: titleFor(defaults.defaults, item.agentId, label),
        kind: "agent",
        agentId: item.agentId,
        program: born.program,
        args: born.args,
        cwd: at.path,
        // A pane, always. It used to follow whatever the destination was
        // showing, which meant provisioning onto a ground with the board up
        // dealt the agent a card — the canvas being written to by something
        // that has nothing to do with it.
        surface: "grid",
      });
      await startTerminalProcess(terminalId, {
        program: born.program,
        args: born.args,
        cwd: at.path,
        kind: "agent",
        title: label,
      });
      // Typed in once the CLI is up and quiet — never awaited, because an
      // agent takes seconds to paint its banner and the batch has rows left.
      const briefing = [launch.briefing, item.prompt.trim()].filter(Boolean).join("\n\n");
      if (briefing) void deliverBriefing(terminalId, briefing);
      return terminalId;
    },

    removeWorktree: async (path: string): Promise<void> => {
      await ipc.worktreeRemove(input.projectPath, path, null);
    },

    deleteBranch: async (branch: string, expectedOid: string): Promise<boolean> => {
      // No OID, no delete. There is no safe way to remove a branch you cannot
      // prove is still where you left it, and "probably fine" is not one.
      if (!branch || !expectedOid) return false;
      return ipc.branchDeleteIfUnchanged(input.projectPath, branch, expectedOid);
    },

    dropGroup: async (groupId: string): Promise<void> => {
      // The ground is never dropped: `use_ground` did not create it, and a
      // rollback that removed it would take the project's own tab bar with it.
      if (groundOf()?.id === groupId) return;
      store().removeGroup(groupId);
    },

    stopAgent: async (terminalId: string): Promise<void> => {
      await closeTerminal(terminalId);
    },
  };
}

/** The last segment of the path the plan chose. */
function folderOf(path: string): string | null {
  const seg = path.split(/[\\/]/).filter(Boolean).pop();
  return seg ?? null;
}
