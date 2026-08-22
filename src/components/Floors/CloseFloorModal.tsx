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
import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";

import { Modal } from "../modals/Modal";
import { closeFloor, closeFloorWarning, liveIdsOf } from "../../lib/floorClose";
import { parseLayout } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import type { GroupRow, ProjectRow } from "../../lib/ipc";

export interface CloseFloorPayload {
  project: ProjectRow;
  group: GroupRow;
}

export function CloseFloorModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as CloseFloorPayload | null;
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);

  const project = payload?.project;
  const group = payload?.group;
  const floor = group ? parseLayout(group.layoutJson).floor : undefined;
  if (!project || !group || !floor) return null;

  const aliveCount = liveIdsOf(group.id).length;
  // The same text the native dialog showed — it already enumerates everything
  // that goes away, including open files not yet saved.
  const [theTitle, ...costs] = closeFloorWarning(group, floor, aliveCount).split("\n");

  const closeIt = async () => {
    setBusy(true);
    try {
      await closeFloor({ project, group, deleteBranch: deleteBranch });
      showToast(`Andar "${group.name}" encerrado.`);
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
            Cancelar
          </button>
          <button
            className="btn btn--danger"
            disabled={busy}
            onClick={() => void closeIt()}
          >
            <Trash2 size={13} aria-hidden="true" />
            {busy ? "Encerrando…" : "Encerrar andar"}
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

      {floor.kind === "isolated" && floor.branch && (
        <div className="floors-after">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
            />
            Apagar também a branch <code>{floor.branch}</code> (desmarcado, ela
            continua no repositório)
          </label>
        </div>
      )}

      <p className="hint">
        Com trabalho não commitado no andar o encerramento é recusado — nada é
        apagado até a árvore estar limpa.
      </p>
    </Modal>
  );
}
