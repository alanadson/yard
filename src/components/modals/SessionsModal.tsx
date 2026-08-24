/**
 * Sessions the agents have already recorded in this folder — the path to
 * "resume that conversation" without memorizing a session id (§F4).
 */
import { useEffect, useRef, useState } from "react";
import { Bot, Play, RefreshCw } from "lucide-react";

import { Modal } from "./Modal";
import { BrandIcon } from "../BrandIcon";
import { brandById } from "../../lib/brands";
import { placeCard } from "../../lib/canvasWrite";
import { AsyncDisposer } from "../../lib/disposables";
import { compactCount, kb, truncate } from "../../lib/format";
import { sameRoot } from "../../lib/roots";
import {
  ipc,
  on,
  type AgentSession,
  type SessionUsage,
} from "../../lib/ipc";
import { useAgentDefaults } from "../../stores/agentDefaultsStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

const AGENTS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
];

export function SessionsModal({ projectPath }: { projectPath: string }) {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const addTerminal = useProjects((s) => s.addTerminal);
  const addGroup = useProjects((s) => s.addGroup);

  const [agent, setAgent] = useState("claude");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const [usage, setUsage] = useState<Record<string, SessionUsage>>({});
  /** File of the session being resumed — locks that row's button. */
  const [resuming, setResuming] = useState<string | null>(null);

  const load = async (agentId: string) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const next = await ipc.listAgentSessions(agentId, projectPath);
      if (generation === loadGeneration.current) setSessions(next);
    } catch (e) {
      // A failure used to fall through as "Nenhuma sessao encontrada": the
      // user reads "there is nothing here" and stops looking, when the right
      // reaction is to try again.
      if (generation === loadGeneration.current) {
        setSessions([]);
        setError(String(e));
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load(agent);
    return () => {
      loadGeneration.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, projectPath]);

  // The backend watcher notifies when the agent writes something new.
  useEffect(() => {
    const subscription = new AsyncDisposer();
    void subscription.add(on.agentsChanged(() => void load(agent)));
    return () => subscription.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, projectPath]);

  /**
   * The group the resumed CLI belongs in.
   *
   * It has to be a group of **this modal's project**. Using `activeGroupId`
   * unconditionally — as this did — put the terminal in whatever group was on
   * screen: open "Sessões de agentes…" from project A's menu while looking at
   * project B and the agent was born in B, with A's `cwd`.
   */
  const targetGroup = (): string | null => {
    const s = useProjects.getState();
    const project =
      s.projects.find((p) => sameRoot(p.path, projectPath)) ??
      s.projects.find((p) => p.id === s.activeProjectId) ??
      s.projects[0];
    if (!project) return null;
    const ofProject = s.groupsOf(project.id);
    // Prefer the group on screen, but only when it is one of this project's.
    const isActive = ofProject.find((g) => g.id === s.activeGroupId);
    return isActive?.id ?? ofProject[0]?.id ?? addGroup(project.id);
  };

  const resume = async (s: AgentSession) => {
    // Two clicks used to create two terminals resuming the same session —
    // there is an `await` before anything is created, and nothing held the
    // door.
    if (resuming) return;
    setResuming(s.file);
    try {
      const args = await ipc.agentResumeArgs(s.agent, s.externalId);
      if (!args) {
        showToast(`${s.agent} nao expoe comando de retomada.`, "error");
        return;
      }
      const groupId = targetGroup();
      if (!groupId) {
        showToast("Cadastre um projeto primeiro.", "error");
        return;
      }
      const detected = await ipc.detectAgents(false);
      const info = detected.find((a) => a.id === s.agent);
      const cwd = s.projectPath || projectPath;
      // The line configured for this CLI holds for a resumed conversation too
      // — there is no dialog here to pre-fill it into — and so does where it
      // runs. `resume` below stays the bare resume argv: it is the session's
      // identity, not the command line.
      const born = useAgentDefaults.getState().launchOf(s.agent, {
        program: info?.bin ?? s.agent,
        args,
        cwd,
      });
      // A resumed session comes back on the surface the user is looking at —
      // a tab among the tabs, or a card on the board.
      const surface = useProjects.getState().layoutOf(groupId).surface;
      const id = addTerminal({
        groupId,
        program: born.program,
        args: born.args,
        cwd,
        kind: "agent",
        title: s.title ? truncate(s.title, 28) : `${s.agent} (retomado)`,
        agentId: s.agent,
        resume: args,
        surface,
      });
      // On the board it belongs where the user last pointed, not at the next
      // automatic slot.
      if (surface === "canvas") placeCard(groupId, id);
      useProjects.getState().updateTerminal(id, { alive: true });
      closeModal();
    } catch (e) {
      showToast(`Não consegui retomar: ${e}`, "error");
    } finally {
      setResuming(null);
    }
  };

  const loadUsage = async (s: AgentSession) => {
    try {
      const u = await ipc.getSessionUsage(s.file);
      setUsage((prev) => ({ ...prev, [s.file]: u }));
    } catch (e) {
      showToast(`Não consegui ler o uso desta sessão: ${e}`, "error");
    }
  };

  return (
    <Modal title="Sessões de agentes" onClose={closeModal} wide>
      {/* Same tab semantics as the other modals: these were plain buttons,
          so nothing announced which agent was selected. */}
      <div className="tabs" role="tablist">
        {AGENTS.map((a) => {
          const brand = brandById(a.id);
          return (
            <button
              key={a.id}
              role="tab"
              aria-selected={agent === a.id}
              className={agent === a.id ? "is-active" : ""}
              onClick={() => setAgent(a.id)}
            >
              {brand ? <BrandIcon brand={brand} size={13} /> : <Bot size={13} />}{" "}
              {a.name}
            </button>
          );
        })}
        <button
          className="icon-btn tabs-right"
          data-tip="Recarregar"
          aria-label="Recarregar a lista de sessões"
          onClick={() => void load(agent)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <p className="hint">
        Lendo de <code>{projectPath || "(todos os projetos)"}</code>
      </p>

      {loading && <p className="hint">Carregando…</p>}
      {err && (
        <p className="hint hint--error">
          Não consegui ler as sessões: {err}. Use o botão de recarregar.
        </p>
      )}
      {!loading && !err && sessions.length === 0 && (
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
                  <button className="btn" onClick={() => void loadUsage(s)}>
                    Uso
                  </button>
                )}
                <button
                  className="btn btn--primary"
                  disabled={resuming !== null}
                  onClick={() => void resume(s)}
                >
                  <Play size={12} />
                  {resuming === s.file ? "Retomando…" : "Retomar"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
