/**
 * Sessions the agents have already recorded in this folder — the path to
 * "resume that conversation" without memorizing a session id (§F4).
 */
import { useEffect, useState } from "react";
import { Bot, Play, RefreshCw } from "lucide-react";

import { Modal } from "./Modal";
import { compactCount, kb, truncate } from "../../lib/format";
import {
  ipc,
  on,
  type AgentSession,
  type SessionUsage,
  type UnlistenFn,
} from "../../lib/ipc";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

const AGENTES = [
  { id: "claude", nome: "Claude Code" },
  { id: "codex", nome: "Codex" },
  { id: "opencode", nome: "OpenCode" },
];

export function SessionsModal({ projectPath }: { projectPath: string }) {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const addTerminal = useProjects((s) => s.addTerminal);
  const addGroup = useProjects((s) => s.addGroup);
  const projects = useProjects((s) => s.projects);

  const [agent, setAgent] = useState("claude");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<Record<string, SessionUsage>>({});

  const carregar = async (agentId: string) => {
    setLoading(true);
    try {
      setSessions(await ipc.listAgentSessions(agentId, projectPath));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void carregar(agent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, projectPath]);

  // The backend watcher notifies when the agent writes something new.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    void on.agentsChanged(() => void carregar(agent)).then((fn) => {
      un = fn;
    });
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  const retomar = async (s: AgentSession) => {
    const args = await ipc.agentResumeArgs(s.agent, s.externalId);
    if (!args) {
      showToast(`${s.agent} nao expoe comando de retomada.`, "error");
      return;
    }
    let groupId = activeGroupId;
    if (!groupId) {
      const project =
        projects.find((p) => p.path === projectPath) ?? projects[0];
      if (!project) {
        showToast("Cadastre um projeto primeiro.", "error");
        return;
      }
      groupId = addGroup(project.id);
    }
    const detected = await ipc.detectAgents(false);
    const info = detected.find((a) => a.id === s.agent);
    const id = addTerminal({
      groupId,
      program: info?.bin ?? s.agent,
      args,
      cwd: s.projectPath || projectPath,
      kind: "agent",
      title: s.title ? truncate(s.title, 28) : `${s.agent} (retomado)`,
      agentId: s.agent,
      resume: args,
    });
    useProjects.getState().updateTerminal(id, { alive: true });
    closeModal();
  };

  const carregarUso = async (s: AgentSession) => {
    const u = await ipc.getSessionUsage(s.file);
    setUsage((prev) => ({ ...prev, [s.file]: u }));
  };

  return (
    <Modal title="Sessões de agentes" onClose={closeModal} wide>
      <div className="tabs">
        {AGENTES.map((a) => (
          <button
            key={a.id}
            className={agent === a.id ? "is-active" : ""}
            onClick={() => setAgent(a.id)}
          >
            <Bot size={13} /> {a.nome}
          </button>
        ))}
        <button
          className="icon-btn tabs-right"
          data-tip="Recarregar"
          onClick={() => void carregar(agent)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <p className="hint">
        Lendo de <code>{projectPath || "(todos os projetos)"}</code>
      </p>

      {loading && <p className="hint">Carregando…</p>}
      {!loading && sessions.length === 0 && (
        <p className="hint">
          Nenhuma sessao encontrada para este agente nesta pasta.
        </p>
      )}

      <div className="session-list">
        {sessions.map((s) => {
          const u = usage[s.file];
          return (
            <div key={s.file} className="session">
              <div className="session-main">
                <strong>{s.title ?? s.externalId}</strong>
                <small>
                  {new Date(s.updatedAt).toLocaleString()} ·{" "}
                  {kb(s.sizeBytes)} · {s.externalId.slice(0, 8)}
                </small>
                {u && (
                  <small className="session-usage">
                    {u.messages} eventos · {compactCount(u.inputTokens)} entrada ·{" "}
                    {compactCount(u.outputTokens)} saida
                    {u.costUsd != null && ` · ~US$ ${u.costUsd.toFixed(2)}`}
                    {u.models.length > 0 && ` · ${u.models.join(", ")}`}
                  </small>
                )}
              </div>
              <div className="session-actions">
                {!u && (
                  <button className="btn" onClick={() => void carregarUso(s)}>
                    Uso
                  </button>
                )}
                <button className="btn btn--primary" onClick={() => void retomar(s)}>
                  <Play size={12} /> Retomar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

