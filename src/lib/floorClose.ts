/**
 * Closing a floor: kill its PTYs, run teardown, remove the worktree, drop
 * the group. Extracted from the popover so landing and compare can do the
 * same thing after a merge without going through the list UI.
 */
import { ipc, type GroupRow, type ProjectRow } from "./ipc";
import { floorHookEnv, type FloorMeta } from "./floors";
import type { RemoteBranch } from "./floorSync";
import { closeGroup } from "./lifecycle";
import { uiLog } from "./log";
import { unsavedWarning } from "../stores/editorStore";
import { parseLayout } from "../stores/projectsStore";
import { isLive, useTerminals } from "../stores/terminalsStore";
import { useProjects } from "../stores/projectsStore";
import { runFloorHooks } from "./floorHooks";
import { useUI } from "../stores/uiStore";
import { t } from "./i18n";

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
    t('Encerrar a frente "{name}"?\n\n', { name: group.name }) +
    (liveCount
      ? t(
          "• {n} terminal(is) rodando serão encerrados agora — no Windows eles trancam a pasta do worktree.\n",
          { n: liveCount },
        )
      : "") +
    t("• Os cartões, o canvas e as rotinas desta frente vão embora.\n") +
    // What the Yard did not create, the Yard does not delete: an adopted
    // worktree existed before this front and stays after it.
    (isolated && floor.adopted
      ? t("• O worktree em {path} fica no disco: a frente só o adotou.\n", {
          path: floor.worktreePath ?? "",
        })
      : isolated
        ? t("• O worktree em {path} é apagado do disco.\n", { path: floor.worktreePath ?? "" })
        : "") +
    unsavedWarning({ groupId: group.id })
  );
}

export async function closeFloor(opts: {
  project: ProjectRow;
  group: GroupRow;
  deleteBranch: boolean;
  /**
   * Also delete the branch **on the server**, when the local one really goes.
   * Absent (the default) the published copy is left exactly where it is.
   */
  deleteRemote?: RemoteBranch | null;
  /** After a successful land the work is on the ground — dirty is stale. */
  skipDirtyCheck?: boolean;
}): Promise<void> {
  const floor = parseLayout(opts.group.layoutJson).floor;
  if (!floor) throw new Error(t("este grupo não é uma frente"));
  const isolated = floor.kind === "isolated" && !!floor.worktreePath;

  if (isolated && !opts.skipDirtyCheck) {
    let dirty: boolean;
    try {
      dirty = await ipc.worktreeDirty(floor.worktreePath!);
    } catch (e) {
      uiLog.warn(`worktree_dirty falhou em ${floor.worktreePath}: ${e}`);
      throw new Error(
        t(
          'Não consegui verificar se a frente "{name}" tem trabalho pendente — encerramento cancelado por segurança.',
          { name: opts.group.name },
        ),
      );
    }
    if (dirty) {
      throw new Error(
        t(
          'A frente "{name}" tem trabalho não commitado — faça commit (ou descarte) antes de encerrar.',
          { name: opts.group.name },
        ),
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
          t('A limpeza da frente "{name}" falhou: {detail}. A frente foi encerrada assim mesmo.', {
            name: opts.group.name,
            detail: r.detail,
          }),
          "error",
        );
    }
  }

  // An adopted worktree was on the disk before this front and stays after it,
  // branch included: removing it would delete work the app never provisioned.
  if (isolated && !floor.adopted) {
    const removal = await ipc.worktreeRemove(
      opts.project.path,
      floor.worktreePath!,
      opts.deleteBranch ? floor.branch : null,
    );
    // The backend refuses to delete a branch holding commits the ground does
    // not have. That refusal is the point, and it has to be *said*: closing
    // ten fronts believing ten branches went with them is how a repository
    // fills up with work nobody remembers leaving behind.
    if (removal?.branchKept) {
      uiLog.warn(`branch ${floor.branch} mantida: ${removal.branchKept}`); // i18n-ok: log line
      useUI
        .getState()
        .showToast(
          t(
            'A branch {branch} tem commits que ainda não estão no chão, então ela foi mantida. Encerrei a frente "{name}" assim mesmo.',
            { branch: floor.branch ?? "?", name: opts.group.name },
          ),
          "info",
        );
    }

    // The published branch goes only when the local one really went.
    // `branchKept` is git refusing `branch -d`, which is git saying this
    // branch holds commits the ground does not have, and in that case the
    // copy on the server is the only other place that work exists.
    if (opts.deleteBranch && opts.deleteRemote && !removal?.branchKept) {
      const { remote, branch } = opts.deleteRemote;
      try {
        await ipc.scmPushDelete(opts.project.path, remote, branch);
      } catch (e) {
        uiLog.warn(`git push ${remote} --delete ${branch} falhou: ${e}`); // i18n-ok: log line
        useUI
          .getState()
          .showToast(
            t(
              "Não consegui apagar {upstream} no servidor: {detail}. A frente foi encerrada e a branch local, apagada.",
              { upstream: `${remote}/${branch}`, detail: String(e) },
            ),
            "error",
          );
      }
    }
  }

  await closeGroup(opts.group.id);
}
