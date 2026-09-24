/**
 * Giving (or changing) the role of a terminal that already exists — the same
 * picker the "new terminal" dialog shows, reached from a card on the canvas or
 * from a tab in the pane.
 *
 * The dialog itself only decides *what* the role is and writes it to the
 * canvas; `applyRoleToProcess` is what reaches the CLI, and it is shared with
 * `yard role set` so the two doors cannot drift apart.
 */
import { useEffect, useRef, useState } from "react";

import { Modal } from "./Modal";
import { reportRoleDelivery } from "./roleDelivery";
import { RoleField } from "./RoleField";
import { useT } from "../../hooks/useT";
import { useDraftExit } from "../../hooks/useDraftExit";
import { commitCanvasExternal } from "../../lib/canvasWrite";
import { setEntry } from "../../lib/canvasOps";
import { applyRoleToProcess } from "../../lib/roleBrief";
import { launchHint, type RolePick } from "../../lib/roles";
import { baseName } from "../../lib/terminals";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  terminalId?: string;
}

export function RoleModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const terminalId = payload?.terminalId ?? "";
  const term = useProjects((s) => s.terminal(terminalId));
  const canvas = useProjects((s) => (term ? s.layoutOf(term.groupId).canvas : undefined));

  const current = term ? canvas?.roles?.[term.id] : undefined;
  const [delivery, setDelivery] = useState<"idle" | "pending" | "failed">("idle");
  const [pick, setPick] = useState<RolePick | null>(
    current ? { role: current, color: canvas?.nodes?.[terminalId]?.color } : null,
  );
  const [initialPick] = useState(pick);
  const [editingDraft, setEditingDraft] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const requestClose = useDraftExit(delivery === "idle" && (editingDraft || JSON.stringify(pick) !== JSON.stringify(initialPick)), closeModal);

  if (!term) {
    return (
      <Modal title={t("Papel do agente")} onClose={closeModal}>
        <p className="hint hint--error">{t("Este terminal não existe mais.")}</p>
      </Modal>
    );
  }

  const save = async () => {
    if (delivery === "pending" || editingDraft) return;
    setDelivery("pending");
    commitCanvasExternal(term.groupId, (c) => ({
      ...c,
      roles: setEntry(c.roles, term.id, pick?.role),
      nodes:
        pick?.color && c.nodes[term.id]
          ? { ...c.nodes, [term.id]: { ...c.nodes[term.id], color: pick.color } }
          : c.nodes,
    }));
    await reportRoleDelivery(applyRoleToProcess(term, current, pick?.role), () => mounted.current, (delivered, active) => {
      if (!delivered) {
        if (active) setDelivery("failed");
        showToast(t("Papel salvo, mas não foi possível confirmar o envio. Confira o terminal antes de tentar novamente."), "error", baseName(term));
        return;
      }
      const message = pick?.role.text && term.kind === "agent"
        ? t('Papel "{name}" definido. Instruções enviadas ao terminal.', { name: pick.role.name })
        : pick ? t('Papel "{name}" definido.', { name: pick.role.name }) : t("Papel removido.");
      showToast(message, "info", baseName(term));
    }, closeModal);
  };

  return (
    <Modal
      title={t("Papel — {name}", { name: baseName(term) })}
      onClose={requestClose}
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={requestClose}>
            {delivery === "idle" ? t("Cancelar") : t("Fechar")}
          </button>
          <button className="btn btn--primary" disabled={delivery === "pending" || editingDraft} onClick={() => void save()}>
            {delivery === "pending" ? t("Aguardando terminal…") : delivery === "failed" ? t("Tentar novamente") : t("Aplicar")}
          </button>
        </div>
      }
    >
      {delivery === "pending" && <p className="hint" role="status">{t("Papel salvo. Aguardando a CLI iniciar e ficar ociosa para enviar as instruções. Você pode fechar esta janela.")}</p>}
      {delivery === "failed" && <p className="hint hint--error" role="alert">{t("Papel salvo, mas não foi possível confirmar o envio. Confira o terminal antes de tentar novamente.")}</p>}
      <fieldset disabled={delivery === "pending"} className="form-fieldset">
      <RoleField
        groupId={term.groupId}
        hint={launchHint(term.agentId)}
        value={pick}
        onChange={(next) => { setPick(next); setDelivery("idle"); }}
        onDraftChange={setEditingDraft}
      />
      {editingDraft && <p className="hint" role="status">{t("Salve ou cancele a edição do papel antes de aplicar.")}</p>}
      </fieldset>
      {term.kind !== "agent" && (
        <p className="hint">
          {t(
            "Este terminal é um shell: o papel fica no cartão como etiqueta, mas não há agente para receber instruções.",
          )}
        </p>
      )}
    </Modal>
  );
}
