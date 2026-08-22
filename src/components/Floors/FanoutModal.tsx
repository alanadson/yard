/**
 * "Nova tarefa": one prompt, N agents, each in its own floor.
 */
import { useCallback, useEffect, useState } from "react";
import { Split } from "lucide-react";

import { Modal } from "../modals/Modal";
import { BrandIcon } from "../BrandIcon";
import { brandById } from "../../lib/brands";
import { agentAsFanout, fanOutTask } from "../../lib/floorFanout";
import { LOADING, load, type LoadState } from "../../lib/loading";
import { ipc, type AgentInfo } from "../../lib/ipc";
import { useChanges } from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

export function FanoutModal() {
  const closeModal = useUI((s) => s.closeModal);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as { projectId?: string } | null;
  const projects = useProjects((s) => s.projects);
  const project =
    projects.find((p) => p.id === payload?.projectId) ??
    projects.find((p) => p.id === useProjects.getState().activeProjectId);

  const [itemName, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agents, setAgents] = useState<LoadState<AgentInfo[]>>(LOADING);
  const [chosen, setChosenIds] = useState<string[]>([]);
  const [cloneGround, setCloneGround] = useState(false);
  const [busy, setBusy] = useState(false);
  const isRepo = useChanges((s) =>
    project ? (s.gitByProject[project.id]?.isRepo ?? true) : false,
  );

  const search = useCallback(() => {
    setAgents(LOADING);
    void load(ipc.detectAgents(false)).then((r) => {
      setAgents(r);
      if (r.state !== "pronto") return;
      // Two, not all. Each one ticked is a worktree on disk, an agent process
      // and a full round of tokens on the same request — ticking the whole
      // machine by default charges dearly for a click that looks light.
      setChosenIds(
        r.data
          .filter((a) => a.installed && a.bin)
          .slice(0, 2)
          .map((a) => a.id),
      );
    });
  }, []);

  useEffect(search, [search]);

  if (!project) return null;

  const installed = (agents.state === "pronto" ? agents.data : []).filter(
    (a) => a.installed && a.bin,
  );

  const launch = async () => {
    const picks = installed.filter((a) => chosen.includes(a.id));
    const fan = picks.map(agentAsFanout).filter((a): a is NonNullable<typeof a> => !!a);
    setBusy(true);
    try {
      const result = await fanOutTask({
        projectId: project.id,
        name: itemName,
        prompt,
        agents: fan,
        copyGround: cloneGround,
      });
      const launched = result.floors.length - result.notStarted.length;
      showToast(
        result.failures.length
          ? `Tarefa “${itemName.trim()}”: ${launched} de ${fan.length} no ar. ` +
              `${result.failures.join("; ")}.` +
              (result.notStarted.length
                ? " Os andares existem — use ▶ no cartão para iniciar."
                : "")
          : `Tarefa “${itemName.trim()}”: ${launched} andar(es) no ar.`,
        result.failures.length ? "error" : "info",
      );
      closeModal();
      openModal("compare-floors", { projectId: project.id });
    } catch (e) {
      showToast(`Não consegui disparar a tarefa: ${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const ready =
    isRepo && !!itemName.trim() && !!prompt.trim() && chosen.length > 0 && !busy;

  return (
    <Modal
      title="Nova tarefa"
      onClose={closeModal}
      dirty={!!itemName.trim() || !!prompt.trim()}
      initialFocus="#fanout-nome"
      footer={
        <div className="modal-foot-row">
          <span className="hint grow">
            {!isRepo
              ? "Esta pasta não é um repositório git — sem worktree os agentes se atropelam."
              : chosen.length > 0
                ? // The price in front of the button: worktrees on disk, agent
                  // processes and the same request billed to every subscription.
                  `${chosen.length} worktree(s) no disco e ${chosen.length} agente(s) rodando o mesmo pedido — depois você compara e aterrissa o vencedor.`
                : "Escolha ao menos um agente. Cada um ganha um andar isolado com o mesmo pedido."}
          </span>
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button
            className="btn btn--primary"
            disabled={!ready}
            onClick={() => void launch()}
          >
            <Split size={13} aria-hidden="true" />
            {busy ? "Disparando…" : `Disparar em ${chosen.length}`}
          </button>
        </div>
      }
    >
      <div className="form">
        <label>
          Nome
          <input
            id="fanout-nome"
            value={itemName}
            placeholder="ex.: validar o checkout"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Pedido
          <textarea
            rows={5}
            value={prompt}
            placeholder="O que cada agente deve fazer neste worktree."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <fieldset className="floors-agents">
          <legend>Agentes nesta máquina</legend>
          {agents.state === "carregando" && <p className="hint">Procurando CLIs…</p>}
          {/* A detection that failed must not become "no CLI installed": the
              user would give up on the fan-out because of a read error. */}
          {agents.state === "falhou" && (
            <p className="hint hint--error" role="alert">
              Não consegui procurar as CLIs: {agents.reason}.{" "}
              <button className="linkish" onClick={search}>
                Procurar de novo
              </button>
            </p>
          )}
          {agents.state === "pronto" && installed.length === 0 && (
            <p className="hint">Nenhuma CLI de agente instalada.</p>
          )}
          {installed.map((a) => {
            const on = chosen.includes(a.id);
            const brand = brandById(a.id);
            return (
              <label key={a.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setChosenIds((cur) =>
                      on ? cur.filter((id) => id !== a.id) : [...cur, a.id],
                    )
                  }
                />
                {brand ? <BrandIcon brand={brand} size={13} /> : null}
                {a.name}
                {a.version && <span className="hint"> {a.version}</span>}
              </label>
            );
          })}
        </fieldset>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={cloneGround}
            onChange={(e) => setCloneGround(e.target.checked)}
          />
          Clonar o layout do chão (terminais extra nascem parados)
        </label>
      </div>
    </Modal>
  );
}
