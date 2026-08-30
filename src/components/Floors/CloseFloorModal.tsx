/**
 * Closing a floor: what gets lost and the decision about the branch, on one
 * screen.
 *
 * It used to be two native dialogs in sequence — "close?" and, right after,
 * "delete the branch too?" — with the second changing the contract of the
 * first once the list of costs had already left the screen. Landing solved
 * that pattern with checkboxes beside the preview; this is the same shape,
 * for the neighbouring gesture.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";

import { Modal } from "../modals/Modal";
import { closeFloor, closeFloorWarning, liveIdsOf } from "../../lib/floorClose";
import { publishStateOf, remoteToDelete, type RemoteBranch } from "../../lib/floorSync";
import { parseLayout } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { ipc, type GroupRow, type ProjectRow } from "../../lib/ipc";
import { useT } from "../../hooks/useT";

export interface CloseFloorPayload {
  project: ProjectRow;
  group: GroupRow;
}

export function CloseFloorModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as CloseFloorPayload | null;
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The published copy of this front's branch, when there is one.
   *
   * Deleting the local branch and leaving the server's is how a repository
   * ends up with a dozen `yard/*` branches nobody meant to keep, and the
   * person who has to clean them up is never the one who made them.
   */
  const [remote, setRemote] = useState<RemoteBranch | null>(null);

  const project = payload?.project;
  const group = payload?.group;
  const floor = group ? parseLayout(group.layoutJson).floor : undefined;
  const branch = floor?.branch;

  useEffect(() => {
    const root = project?.path;
    if (!root || !branch) return;
    let alive = true;
    void (async () => {
      try {
        const branches = await ipc.scmBranches(root);
        // `hasRemote` is implied here: a branch only carries an upstream when
        // there is a remote to carry it to.
        if (alive) setRemote(remoteToDelete(publishStateOf(branches, branch, true)));
      } catch {
        // No listing, no offer: the checkbox simply does not appear, and the
        // close behaves exactly as it did before.
      }
    })();
    return () => {
      alive = false;
    };
  }, [project?.path, branch]);

  if (!project || !group || !floor) return null;

  const aliveCount = liveIdsOf(group.id).length;
  // The same text the native dialog showed — it already enumerates everything
  // that goes away, including open files not yet saved.
  const [theTitle, ...costs] = closeFloorWarning(group, floor, aliveCount).split("\n");

  const closeIt = async () => {
    setBusy(true);
    try {
      await closeFloor({
        project,
        group,
        deleteBranch,
        deleteRemote: deleteBranch && deleteRemote ? remote : null,
      });
      showToast(t('Frente "{name}" encerrada.', { name: group.name }));
      closeModal();
    } catch (e) {
      // Uncommitted work (the most common refusal) arrives here as an error:
      // the dialog stays open for the user to sort it out and try again.
      showToast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={theTitle.replace(/\?$/, "")}
      onClose={closeModal}
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            {t("Cancelar")}
          </button>
          <button
            className="btn btn--danger"
            disabled={busy}
            onClick={() => void closeIt()}
          >
            <Trash2 size={13} aria-hidden="true" />
            {busy ? t("Encerrando…") : t("Encerrar frente")}
          </button>
        </div>
      }
    >
      <ul className="floors-costs">
        {costs
          .map((line) => line.trim())
          .filter(Boolean)
          .map((row) => (
            <li key={row}>
              <AlertTriangle size={12} aria-hidden="true" />
              <span>{row.replace(/^•\s*/, "")}</span>
            </li>
          ))}
      </ul>

      {/* An adopted worktree is not removed, and `worktree_remove` is what
          would have deleted the branch with it, so offering the checkbox here
          would promise something the close never does. */}
      {floor.kind === "isolated" && floor.branch && !floor.adopted && (
        <div className="floors-after">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
            />
            {t("Apagar também a branch")} <code>{floor.branch}</code>{" "}
            {t("(desmarcado, ela continua no repositório)")}
          </label>
          {/* The other half of "apagar a branch": the front was published at
              some point and that copy outlives the local one unless somebody
              says otherwise. Nested under the first box because it can only
              happen together with it. */}
          {remote && (
            <label className="checkbox floors-after-nested">
              <input
                type="checkbox"
                disabled={!deleteBranch}
                checked={deleteBranch && deleteRemote}
                onChange={(e) => setDeleteRemote(e.target.checked)}
              />
              {t("Apagar também no servidor")}{" "}
              <code>
                {remote.remote}/{remote.branch}
              </code>
            </label>
          )}
        </div>
      )}

      <p className="hint">
        {t(
          "Com trabalho não commitado na frente o encerramento é recusado — nada é apagado até a árvore estar limpa.",
        )}
        {/* The checkbox is a request, not a promise: a branch holding commits
            the ground does not have survives it, and saying so here is
            cheaper than the surprise afterwards. */}
        {floor.kind === "isolated" && floor.branch && !floor.adopted
          ? " " +
            t(
              "Uma branch com commits que ainda não estão no chão é mantida mesmo com a caixa marcada.",
            )
          : ""}
        {/* The order matters and is worth saying: the server copy is the last
            place that work would exist if the local delete was refused. */}
        {remote
          ? " " +
            t(
              "A cópia no servidor só é apagada depois que a local for mesmo apagada.",
            )
          : ""}
      </p>
    </Modal>
  );
}
