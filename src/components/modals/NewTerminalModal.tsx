/**
 * "New terminal": a regular shell or an agent detected on the machine.
 *
 * The agent list comes from `agents/resolver.rs`, which already resolved
 * npm `.cmd` shims — so what shows up here is exactly what can run (§9.3).
 *
 * Opening from a pane's "+" sends `groupId`/`slot` in the payload: the CLI
 * is born where the user clicked, not always in pane 0.
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, RefreshCw, Terminal as TerminalIcon } from "lucide-react";

import { Modal } from "./Modal";
import { ipc, type AgentInfo, type ShellOption } from "../../lib/ipc";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  groupId?: string;
  slot?: number;
}

export function NewTerminalModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const projects = useProjects((s) => s.projects);
  const groups = useProjects((s) => s.groups);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const addTerminal = useProjects((s) => s.addTerminal);
  const addGroup = useProjects((s) => s.addGroup);
  const projectOfGroup = useProjects((s) => s.projectOfGroup);

  const [tab, setTab] = useState<"shell" | "agent">("shell");
  const [shells, setShells] = useState<ShellOption[]>([]);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [groupId, setGroupId] = useState(
    payload?.groupId ?? activeGroupId ?? "",
  );
  const [extraArgs, setExtraArgs] = useState("");
  const [cwdOverride, setCwdOverride] = useState("");

  const group = groups.find((g) => g.id === groupId);
  const project = group ? projectOfGroup(group.id) : undefined;
  const cwd = cwdOverride || project?.path || "";

  useEffect(() => {
    void ipc.listShells().then(setShells);
  }, []);

  useEffect(() => {
    if (tab !== "agent" || agents !== null) return;
    setLoadingAgents(true);
    void ipc
      .detectAgents(false)
      .then(setAgents)
      .finally(() => setLoadingAgents(false));
  }, [tab, agents]);

  const parsedArgs = useMemo(
    () => extraArgs.trim().split(/\s+/).filter(Boolean),
    [extraArgs],
  );

  const ensureGroup = (): string | null => {
    if (groupId) return groupId;
    const project = projects[0];
    if (!project) {
      showToast("Adicione um projeto antes de abrir um terminal.", "error");
      return null;
    }
    return addGroup(project.id);
  };

  const create = (opts: {
    program: string;
    args: string[];
    kind: "shell" | "agent";
    title: string;
    agentId?: string;
  }) => {
    const target = ensureGroup();
    if (!target) return;
    if (!cwd) {
      showToast("Sem pasta de trabalho: cadastre o caminho do projeto.", "error");
      return;
    }
    const id = addTerminal({
      groupId: target,
      // Only honors the requested slot when the CLI is born in the same group
      // as the pane that asked; switching group in the selector goes to the full pane.
      slot: target === payload?.groupId ? payload?.slot : undefined,
      program: opts.program,
      args: [...opts.args, ...parsedArgs],
      cwd,
      kind: opts.kind,
      title: opts.title,
      agentId: opts.agentId ?? null,
    });
    // `alive: true` makes XTermView spawn as soon as it mounts.
    useProjects.getState().updateTerminal(id, { alive: true });
    closeModal();
  };

  const redetectar = () => {
    setLoadingAgents(true);
    void ipc
      .detectAgents(true)
      .then(setAgents)
      .finally(() => setLoadingAgents(false));
  };

  return (
    <Modal
      title="Novo terminal"
      onClose={closeModal}
      wide
      footer={
        <div className="modal-foot-row">
          <label>
            Grupo
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              {groups.length === 0 && <option value="">(criar novo)</option>}
              {groups.map((g) => {
                const p = projects.find((x) => x.id === g.projectId);
                return (
                  <option key={g.id} value={g.id}>
                    {p?.name} › {g.name}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="grow">
            Pasta de trabalho
            <input
              value={cwd}
              placeholder="pasta do projeto"
              onChange={(e) => setCwdOverride(e.target.value)}
            />
          </label>
          <label className="grow">
            Argumentos extras
            <input
              value={extraArgs}
              placeholder="ex.: --dangerously-skip-permissions"
              onChange={(e) => setExtraArgs(e.target.value)}
            />
          </label>
        </div>
      }
    >
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "shell"}
          className={tab === "shell" ? "is-active" : ""}
          onClick={() => setTab("shell")}
        >
          <TerminalIcon size={13} /> Shell
        </button>
        <button
          role="tab"
          aria-selected={tab === "agent"}
          className={tab === "agent" ? "is-active" : ""}
          onClick={() => setTab("agent")}
        >
          <Bot size={13} /> Agente
        </button>
      </div>

      {tab === "shell" ? (
        <div className="option-list">
          {shells.length === 0 &&
            [0, 1, 2].map((i) => <div key={i} className="option--skeleton" />)}
          {shells.map((s) => (
            <button
              key={s.id}
              className="option"
              disabled={!s.available}
              onClick={() =>
                create({
                  program: s.program,
                  args: [],
                  kind: "shell",
                  title: s.label,
                })
              }
            >
              <TerminalIcon size={15} />
              <div>
                <strong>{s.label}</strong>
                <small>
                  {s.available ? s.program : "não encontrado nesta máquina"}
                </small>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="option-list">
          <div className="option-list-head">
            <span>{loadingAgents ? "Procurando CLIs…" : "CLIs detectadas"}</span>
            <button
              className={`icon-btn ${loadingAgents ? "is-busy" : ""}`}
              data-tip="Detectar de novo"
              aria-label="Detectar CLIs de novo"
              onClick={redetectar}
            >
              <RefreshCw size={13} />
            </button>
          </div>

          {agents === null &&
            [0, 1, 2].map((i) => <div key={i} className="option--skeleton" />)}

          {(agents ?? []).map((a) => (
            <button
              key={a.id}
              className="option"
              disabled={!a.installed}
              onClick={() =>
                create({
                  program: a.bin ?? a.id,
                  args: [],
                  kind: "agent",
                  title: a.name,
                  agentId: a.id,
                })
              }
            >
              <Bot size={15} />
              <div>
                <strong>{a.name}</strong>
                <small>
                  {a.installed
                    ? (a.version ?? a.bin ?? "")
                    : "não instalado — instale a CLI e detecte de novo"}
                </small>
              </div>
            </button>
          ))}

          {agents !== null && agents.every((a) => !a.installed) && (
            <p className="hint">
              Nenhuma CLI de agente encontrada no PATH nem nas pastas do npm.
              Instale uma (ex.: <code>npm i -g @anthropic-ai/claude-code</code>) e
              clique em detectar de novo.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
