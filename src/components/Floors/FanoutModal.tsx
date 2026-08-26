/**
 * "Nova tarefa": one prompt, N agents, each in its own floor.
 */
import { useCallback, useEffect, useState } from "react";
import { Split } from "lucide-react";

import { Modal } from "../modals/Modal";
import { BrandIcon } from "../BrandIcon";
import { brandById } from "../../lib/brands";
import { pickableAgents } from "../../lib/agentDefaults";
import { agentAsFanout, fanOutTask } from "../../lib/floorFanout";
import { LOADING, load, type LoadState } from "../../lib/loading";
import { ipc, type AgentInfo } from "../../lib/ipc";
import { useAgentDefaults } from "../../stores/agentDefaultsStore";
import { useChanges } from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";

export function FanoutModal() {
  const t = useT();
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
  const defaults = useAgentDefaults((s) => s.defaults);
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
        pickableAgents(
          r.data.filter((a) => a.installed && a.bin),
          useAgentDefaults.getState().defaults,
        )
          .slice(0, 2)
          .map((a) => a.id),
      );
    });
  }, []);

  useEffect(search, [search]);

  if (!project) return null;

  // An agent turned off in Settings is not offered to a fleet either — the
  // fan-out picker is the same kind of list as the grid in "Nova aba".
  const installed = pickableAgents(
    (agents.state === "pronto" ? agents.data : []).filter((a) => a.installed && a.bin),
    defaults,
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
          ? t("Tarefa “{name}”: {launched} de {total} no ar. ", {
              name: itemName.trim(),
              launched,
              total: fan.length,
            }) +
              `${result.failures.join("; ")}.` +
              (result.notStarted.length
                ? t(" As frentes existem — use ▶ no cartão para iniciar.")
                : "")
          : t("Tarefa “{name}”: {n} frente(s) no ar.", { name: itemName.trim(), n: launched }),
        result.failures.length ? "error" : "info",
      );
      closeModal();
      openModal("compare-floors", { projectId: project.id });
    } catch (e) {
      showToast(t("Não consegui disparar a tarefa: {e}", { e: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const ready =
    isRepo && !!itemName.trim() && !!prompt.trim() && chosen.length > 0 && !busy;

  return (
    <Modal
      title={t("Nova tarefa")}
      onClose={closeModal}
      dirty={!!itemName.trim() || !!prompt.trim()}
      initialFocus="#fanout-nome"
      footer={
        <div className="modal-foot-row">
          <span className="hint grow">
            {!isRepo
              ? t("Esta pasta não é um repositório git — sem worktree os agentes se atropelam.")
              : chosen.length > 0
                ? // The price in front of the button: worktrees on disk, agent
                  // processes and the same request billed to every subscription.
                  t(
                    "{n} worktree(s) no disco e {n} agente(s) rodando o mesmo pedido — depois você compara e aterrissa o vencedor.",
                    { n: chosen.length },
                  )
                : t("Escolha ao menos um agente. Cada um ganha uma frente isolada com o mesmo pedido.")}
          </span>
          <button className="btn" onClick={closeModal}>
            {t("Cancelar")}
          </button>
          <button
            className="btn btn--primary"
            disabled={!ready}
            onClick={() => void launch()}
          >
            <Split size={13} aria-hidden="true" />
            {busy ? t("Disparando…") : t("Disparar em {n}", { n: chosen.length })}
          </button>
        </div>
      }
    >
      <div className="form">
        <label>
          {t("Nome")}
          <input
            id="fanout-nome"
            value={itemName}
            placeholder={t("ex.: validar o checkout")}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("Pedido")}
          <textarea
            rows={5}
            value={prompt}
            placeholder={t("O que cada agente deve fazer neste worktree.")}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <fieldset className="floors-agents">
          <legend>{t("Agentes nesta máquina")}</legend>
          {agents.state === "carregando" && <p className="hint">{t("Procurando CLIs…")}</p>}
          {/* A detection that failed must not become "no CLI installed": the
              user would give up on the fan-out because of a read error. */}
          {agents.state === "falhou" && (
            <p className="hint hint--error" role="alert">
              {t("Não consegui procurar as CLIs: {reason}.", { reason: agents.reason })}{" "}
              <button className="linkish" onClick={search}>
                {t("Procurar de novo")}
              </button>
            </p>
          )}
          {agents.state === "pronto" && installed.length === 0 && (
            <p className="hint">{t("Nenhuma CLI de agente instalada.")}</p>
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
          {t("Clonar o layout do chão (terminais extra nascem parados)")}
        </label>
      </div>
    </Modal>
  );
}
