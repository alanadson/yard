import { useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";

import { useT } from "../../hooks/useT";
import {
  confirmationSnapshot,
  settleConfirmation,
  subscribeConfirmations,
} from "../../lib/confirmation";
import { Modal } from "../modals/Modal";

export function ConfirmHost() {
  const t = useT();
  const request = useSyncExternalStore(
    subscribeConfirmations,
    confirmationSnapshot,
    confirmationSnapshot,
  );
  if (!request) return null;

  const dangerous = request.kind === "warning" || request.kind === "error";
  return (
    <Modal
      title={request.title ?? t("Confirmar ação")}
      onClose={() => settleConfirmation(false)}
      initialFocus=".confirm-cancel"
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn confirm-cancel" onClick={() => settleConfirmation(false)}>
            {request.cancelLabel ?? t("Cancelar")}
          </button>
          <button
            className={`btn ${dangerous ? "btn--danger" : "btn--primary"}`}
            onClick={() => settleConfirmation(true)}
          >
            {request.okLabel ?? t("Confirmar")}
          </button>
        </div>
      }
    >
      <div className="confirm-body">
        {dangerous && <AlertTriangle size={18} aria-hidden="true" />}
        <div>
          {request.message.split(/\n\n+/).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </div>
    </Modal>
  );
}
