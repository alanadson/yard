/**
 * Closing a floor: kill its PTYs, run teardown, remove the worktree, drop
 * the group. Extracted from the popover so landing and compare can do the
 * same thing after a merge without going through the list UI.
 */
import { ipc, type GroupRow, type ProjectRow } from "./ipc";
import { floorHookEnv, type FloorMeta } from "./floors";
import { closeGroup } from "./lifecycle";
import { uiLog } from "./log";
import { unsavedWarning } from "../stores/editorStore";
import { parseLayout } from "../stores/projectsStore";
import { isLive, useTerminals } from "../stores/terminalsStore";
import { useProjects } from "../stores/projectsStore";
import { runFloorHooks } from "./floorHooks";
import { useUI } from "../stores/uiStore";

async function waitForExit(ids: string[], timeoutMs = 6_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const aliveCount = await Promise.all(ids.map((id) => ipc.ptyExists(id).catch(() => false)));
    if (!aliveCount.some(Boolean)) return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

export function liveIdsOf(groupId: string): string[] {
  const runtimes = useTerminals.getState().byId;
  return useProjects
    .getState()
    .terminals.filter((t) => t.groupId === groupId && isLive(runtimes[t.id]))
    .map((t) => t.id);
}

/**
 * The confirmation text for closing a floor — the same list of costs the
 * popover used to assemble inline. Callers that already asked (landing a
 * winner and discarding the losers) skip this and pass `force`.
 */
export function closeFloorWarning(
  group: GroupRow,
  floor: FloorMeta,
  liveCount: number,
): string {
  const isolated = floor.kind === "isolated" && !!floor.worktreePath;
  return (
    `Encerrar o andar "${group.name}"?\n\n` +
    (liveCount
      ? `• ${liveCount} terminal(is) rodando serão encerrados agora — ` +
        "no Windows eles trancam a pasta do worktree.\n"
      : "") +
    "• Os cartões, o canvas e as rotinas deste andar vão embora.\n" +
    (isolated ? `• O worktree em ${floor.worktreePath} é apagado do disco.\n` : "") +
    unsavedWarning({ groupId: group.id })
  );
}

export async function closeFloor(opts: {
  project: ProjectRow;
  group: GroupRow;
  deleteBranch: boolean;
  /** After a successful land the work is on the ground — dirty is stale. */
  skipDirtyCheck?: boolean;
}): Promise<void> {
  const floor = parseLayout(opts.group.layoutJson).floor;
  if (!floor) throw new Error("este grupo não é um andar");
  const isolated = floor.kind === "isolated" && !!floor.worktreePath;

  if (isolated && !opts.skipDirtyCheck) {
    let dirty: boolean;
    try {
      dirty = await ipc.worktreeDirty(floor.worktreePath!);
    } catch (e) {
      uiLog.warn(`worktree_dirty falhou em ${floor.worktreePath}: ${e}`);
      throw new Error(
        `Não consegui verificar se o andar "${opts.group.name}" tem trabalho pendente — encerramento cancelado por segurança.`,
      );
    }
    if (dirty) {
      throw new Error(
        `O andar "${opts.group.name}" tem trabalho não commitado — faça commit (ou descarte) antes de encerrar.`,
      );
    }
  }

  const aliveCount = liveIdsOf(opts.group.id);
  if (aliveCount.length) {
    await Promise.all(aliveCount.map((id) => ipc.killPty(id).catch(() => {})));
    await waitForExit(aliveCount);
  }

  // Teardown comes **before** removal, and inside the worktree — like setup
  // and run, and as the README promises. It used to run after, with the
  // ground's `cwd`: the `npm run clean` from the field's own example had
  // nowhere to run, because the folder no longer existed. The failure was also
  // just a line in the log; when closing a floor, a cleanup that did not
  // happen is something the user needs to know.
  if (floor.hooks?.teardown.length) {
    const r = await runFloorHooks(
      floor.worktreePath ?? opts.project.path,
      floor.hooks.teardown,
      floorHookEnv({
        floorName: opts.group.name,
        branch: floor.branch,
        floorPath: floor.worktreePath ?? opts.project.path,
        rootPath: opts.project.path,
        projectName: opts.project.name,
      }),
    );
    if (!r.ok) {
      uiLog.warn(`Hook de teardown falhou: ${r.detail}`);
      useUI
        .getState()
        .showToast(
          `A limpeza do andar "${opts.group.name}" falhou: ${r.detail}. ` +
            "O andar foi encerrado assim mesmo.",
          "error",
        );
    }
  }

  if (isolated) {
    await ipc.worktreeRemove(
      opts.project.path,
      floor.worktreePath!,
      opts.deleteBranch ? floor.branch : null,
    );
  }

  await closeGroup(opts.group.id);
}
