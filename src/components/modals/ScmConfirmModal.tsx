/**
 * The warning before an irreversible source-control gesture.
 *
 * A single dialog for the five or six gestures that do not come back
 * (discard, delete branch, delete on the server, hard reset, drop stash),
 * because what changes between them is the text — and the text is the
 * product: the sentences are written by `scmConfirm.ts`, which is tested.
 * Only the frame is left here.
 */
import { AlertTriangle } from "lucide-react";

import { Modal } from "./Modal";
import { useUI } from "../../stores/uiStore";
import type { ScmConfirmSpec } from "../../lib/scmConfirm";

export interface ScmConfirmPayload extends ScmConfirmSpec {
  onConfirm: () => void;
}

export function ScmConfirmModal() {
  const closeModal = useUI((s) => s.closeModal);
  const payload = useUI((s) => s.modalPayload) as ScmConfirmPayload | null;
  if (!payload) return null;

  const confirmAction = () => {
    payload.onConfirm();
    closeModal();
  };

  return (
    <Modal
      title={payload.title}
      onClose={closeModal}
      // Focus starts on Cancel: this dialog shows up after a click, and a
      // reflexive Enter right after it must not be what erases the work.
      initialFocus=".btn:not(.btn--danger)"
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn--danger" onClick={confirmAction}>
            {payload.confirmLabel}
          </button>
        </div>
      }
    >
      <p className="hint scm-confirm-lead">
        <AlertTriangle size={13} aria-hidden="true" /> {payload.detail}
      </p>
    </Modal>
  );
}
