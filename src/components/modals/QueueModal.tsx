import { Modal } from "./Modal";
import { queueContentsView, queueDeliveryError, queueDeliveryView } from "./queueView";
import { useT } from "../../hooks/useT";
import { useUI } from "../../stores/uiStore";
import { useQueue } from "../../stores/queueStore";
import { useProjects } from "../../stores/projectsStore";
import { ask } from "../../lib/confirmation";
import { baseName } from "../../lib/terminals";
import { useState } from "react";
import { nanoid } from "nanoid";
import { cancelTaskPrompt, retryTaskPrompt } from "../../lib/taskQueue";

export function QueueModal() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const items = useQueue((state) => state.items);
  const error = useQueue((state) => state.error);
  const terminals = useProjects((state) => state.terminals);
  const close = useUI((state) => state.closeModal);
  const payload = useUI((state) => state.modalPayload) as { terminalId?: string } | null;
  const rows = payload?.terminalId ? items.filter((item) => item.terminalId === payload.terminalId) : items;
  const contents = queueContentsView(rows.length, error);
  const retry = async (id: string) => {
    setBusy(true);
    try {
      if (await ask(t("Você conferiu o terminal? Reenviar pode repetir uma tarefa que já chegou ao agente."), {
        title: t("Reenviar após conferir"), kind: "warning", okLabel: t("Reenviar"),
      })) await retryTaskPrompt(id, nanoid());
    } catch (error) {
      const reason = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      useUI.getState().showToast(t("Não foi possível reenviar o prompt: {reason}.", { reason }), "error");
    } finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    setBusy(true);
    try { await cancelTaskPrompt(id); }
    catch (error) {
      const reason = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      useUI.getState().showToast(t("Não foi possível remover o prompt: {reason}.", { reason }), "error");
    } finally { setBusy(false); }
  };
  return <Modal title={t("Fila de trabalho")} onClose={close} wide>
    {contents.error ? <p className="hint hint--error" role="alert">{contents.error}</p> : null}
    {contents.showEmpty ? <p className="hint">{t("Nenhum prompt na fila.")}</p> :
      <ol className="notification-history">{rows.map((item) => {
        const view = queueDeliveryView(item);
        const terminal = terminals.find((row) => row.id === item.terminalId);
        return <li key={item.id}>
          <div className="notification-history-head">
            <strong>{terminal ? baseName(terminal) : item.terminalId}</strong>
            <span>{t(view.label)}</span>
            {view.retryable ? <button className="btn btn--sm" disabled={busy} onClick={() => void retry(item.id)}>{t("Reenviar após conferir")}</button> : null}
            <button className="btn btn--sm" disabled={busy || !view.removable} onClick={() => void cancel(item.id)}>{t("Remover da fila")}</button>
          </div>
          <p>{item.text}</p>
          <p className="hint">{t(view.explanation)}</p>
          {item.delivery?.error ? <p className="hint hint--error" role="status">{queueDeliveryError(item.delivery.error)}</p> : null}
        </li>;
      })}</ol>}
  </Modal>;
}
