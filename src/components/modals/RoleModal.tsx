/**
 * Giving (or changing) the role of a terminal that already exists — the same
 * picker the "new terminal" dialog shows, reached from a card on the canvas or
 * from a tab in the pane.
 *
 * The dialog itself only decides *what* the role is and writes it to the
 * canvas; `applyRoleToProcess` is what reaches the CLI, and it is shared with
 * `yard role set` so the two doors cannot drift apart.
 */
import { useState } from "react";

import { Modal } from "./Modal";
import { RoleField } from "./RoleField";
import { commitCanvasExternal } from "../../lib/canvasWrite";
import { setEntry } from "../../lib/canvasOps";
import { applyRoleToProcess } from "../../lib/roleBrief";
import { launchHint, type RolePick } from "../../lib/roles";
import { baseName } from "../../lib/terminals";
import { useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  terminalId?: string;
}

export function RoleModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const terminalId = payload?.terminalId ?? "";
  const term = useProjects((s) => s.terminal(terminalId));
  const canvas = useProjects((s) => (term ? s.layoutOf(term.groupId).canvas : undefined));
  const running = useTerminals((s) => isLive(s.byId[terminalId]));

  const current = term ? canvas?.roles?.[term.id] : undefined;
  const [pick, setPick] = useState<RolePick | null>(
    current ? { role: current, color: canvas?.nodes?.[terminalId]?.color } : null,
  );

  if (!term) {
    return (
      <Modal title="Papel do agente" onClose={closeModal}>
        <p className="hint hint--error">Este terminal não existe mais.</p>
      </Modal>
    );
  }

  const save = () => {
    commitCanvasExternal(term.groupId, (c) => ({
      ...c,
      roles: setEntry(c.roles, term.id, pick?.role),
      nodes:
        pick?.color && c.nodes[term.id]
          ? { ...c.nodes, [term.id]: { ...c.nodes[term.id], color: pick.color } }
          : c.nodes,
    }));
    applyRoleToProcess(term, current, pick?.role);

    if (pick?.role.text && term.kind === "agent") {
      showToast(
        running
          ? `Papel "${pick.role.name}" definido — instruções enviadas ao terminal.`
          : `Papel "${pick.role.name}" definido — as instruções vão assim que a CLI subir.`,
      );
    } else {
      showToast(pick ? `Papel "${pick.role.name}" definido.` : "Papel removido.");
    }
    closeModal();
  };

  return (
    <Modal
      title={`Papel — ${baseName(term)}`}
      onClose={closeModal}
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={save}>
            Aplicar
          </button>
        </div>
      }
    >
      <RoleField
        groupId={term.groupId}
        hint={launchHint(term.agentId)}
        value={pick}
        onChange={setPick}
      />
      {term.kind !== "agent" && (
        <p className="hint">
          Este terminal é um shell: o papel fica no cartão como etiqueta, mas
          não há agente para receber instruções.
        </p>
      )}
    </Modal>
  );
}
