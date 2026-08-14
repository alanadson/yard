/**
 * Floors: overview and creation.
 *
 * A floor is a sibling group of the ground with its own git worktree
 * (`.yard/floors/<slug>`), its own canvas and an isolated cwd. The button
 * sits in the bottom-right corner of the workspace (next to the zoom control
 * in canvas mode); the overview lists ground + floors with a branch badge and
 * allows unloading (suspending the PTYs) or closing (removing the worktree).
 *
 * Nothing here kills a process on its own: closing goes through
 * `closeGroup` (lifecycle) and unloading uses `suspend_group`, which
 * preserves scrollback and session.
 */
import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  GitBranch,
  Layers,
  Moon,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import { Modal } from "../modals/Modal";
import { ipc, type GroupRow, type ProjectRow } from "../../lib/ipc";
import {
  floorHookEnv,
  parseHookLines,
  type FloorHooks,
  type FloorMeta,
} from "../../lib/floors";
import { closeGroup } from "../../lib/lifecycle";
import { applyScore, serializeGroup } from "../../lib/scores";
import { uiLog } from "../../lib/log";
import { useChanges } from "../../stores/changesStore";
import { parseLayout, useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

/** Runs a hook's command list in sequence; stops at the first error. */
async function runHookList(
  cwd: string,
  commands: string[],
  env: [string, string][],
): Promise<{ ok: boolean; detail: string }> {
  for (const command of commands) {
    try {
      const r = await ipc.floorRunHook(cwd, command, env);
      if (r.code !== 0) {
        return {
          ok: false,
          detail: `\`${command}\` saiu com código ${r.code}: ${r.output.slice(0, 200)}`,
        };
      }
    } catch (e) {
      return { ok: false, detail: `\`${command}\`: ${e}` };
    }
  }
  return { ok: true, detail: "" };
}

function hookEnvFor(
  group: GroupRow,
  floor: FloorMeta,
  project: { name: string; path: string },
): [string, string][] {
  return floorHookEnv({
    floorName: group.name,
    branch: floor.branch,
    floorPath: floor.worktreePath ?? project.path,
    rootPath: project.path,
    projectName: project.name,
  });
}

// ---------------------------------------------------------------------------
// button + overview
// ---------------------------------------------------------------------------

/**
 * The button lives in every layout mode, so it must be cheap when closed:
 * it subscribes to a project row and a *number*, never to the group or
 * terminal arrays. Those change identity on every layout write — including a
 * canvas commit, which happens per keystroke inside a note.
 */
export function FloorsControl({
  groupId,
  variant,
}: {
  groupId: string;
  variant: "canvas" | "grid";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const project = useProjects((s) => s.projectOfGroup(groupId));
  const floorCount = useProjects((s) =>
    project
      ? s.groups.filter(
          (g) => g.projectId === project.id && parseLayout(g.layoutJson).floor,
        ).length
      : 0,
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!project) return null;

  return (
    <div className={`floors-ctl floors-ctl--${variant}`} ref={rootRef}>
      {open && <FloorsPopover project={project} onClose={() => setOpen(false)} />}
      <button
        className={`floors-btn ${open ? "is-active" : ""}`}
        data-tip-side="top" data-tip-wrap="" data-tip="Andares: cópias isoladas do repositório, cada uma com o próprio canvas"
        aria-label="Andares"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Layers size={13} aria-hidden="true" />
        {floorCount > 0 && <span className="floors-count">{floorCount}</span>}
      </button>
    </div>
  );
}

/** The list itself — mounted only while the popover is open. */
function FloorsPopover({
  project,
  onClose,
}: {
  project: ProjectRow;
  onClose: () => void;
}) {
  const groups = useProjects((s) => s.groups);
  const terminals = useProjects((s) => s.terminals);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const setActiveGroup = useProjects((s) => s.setActiveGroup);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);

  const doProjeto = groups
    .filter((g) => g.projectId === project.id)
    .sort((a, b) => a.sort - b.sort);

  const aliveCount = (gid: string) =>
    terminals.filter((t) => t.groupId === gid && t.alive).length;

  const descarregar = async (g: GroupRow) => {
    const ids = terminals.filter((t) => t.groupId === g.id && t.alive).map((t) => t.id);
    if (ids.length === 0) {
      showToast("Nenhum terminal vivo neste andar.");
      return;
    }
    const falhas = await ipc.suspendGroup(ids);
    showToast(
      falhas.length
        ? `Andar descarregado com ${falhas.length} falha(s).`
        : `Andar "${g.name}" descarregado — sessões preservadas.`,
    );
  };

  const encerrar = async (g: GroupRow) => {
    const floor = parseLayout(g.layoutJson).floor;
    if (!floor) return;
    if (floor.kind === "isolated" && floor.worktreePath) {
      let dirty = false;
      try {
        dirty = await ipc.worktreeDirty(floor.worktreePath);
      } catch (e) {
        uiLog.warn(`worktree_dirty falhou em ${floor.worktreePath}: ${e}`);
      }
      if (dirty) {
        showToast(
          `O andar "${g.name}" tem trabalho não commitado — faça commit (ou descarte) antes de encerrar.`,
          "error",
        );
        return;
      }
    }
    const seguir = await ask(
      `Encerrar o andar "${g.name}"? Os terminais dele são removidos` +
        (floor.kind === "isolated" ? " e o worktree é apagado do disco." : "."),
      { title: "Encerrar andar", kind: "warning" },
    );
    if (!seguir) return;

    if (floor.hooks?.teardown.length && floor.worktreePath) {
      const r = await runHookList(
        floor.worktreePath,
        floor.hooks.teardown,
        hookEnvFor(g, floor, project),
      );
      if (!r.ok) showToast(`Hook de teardown falhou: ${r.detail}`, "error");
    }

    if (floor.kind === "isolated" && floor.worktreePath) {
      let apagarBranch = false;
      if (floor.branch) {
        apagarBranch = await ask(
          `Apagar também a branch "${floor.branch}"? (Não = a branch continua no repositório.)`,
          { title: "Encerrar andar", kind: "info" },
        );
      }
      try {
        await ipc.worktreeRemove(
          project.path,
          floor.worktreePath,
          apagarBranch ? floor.branch : null,
        );
      } catch (e) {
        showToast(`Não consegui remover o worktree: ${e}`, "error");
        return;
      }
    }
    await closeGroup(g.id);
    showToast(`Andar "${g.name}" encerrado.`);
  };

  const rodarHooks = async (g: GroupRow) => {
    const floor = parseLayout(g.layoutJson).floor;
    if (!floor?.hooks?.run.length) return;
    const cwd = floor.worktreePath ?? project.path;
    showToast(`Rodando hooks de "${g.name}"…`);
    const r = await runHookList(cwd, floor.hooks.run, hookEnvFor(g, floor, project));
    showToast(r.ok ? `Hooks de "${g.name}" concluídos.` : `Hook falhou: ${r.detail}`, r.ok ? "info" : "error");
  };

  return (
    <div className="floors-pop" role="menu" aria-label="Andares do projeto">
      <div className="floors-pop-head">
        <span>Andares — {project.name}</span>
      </div>
      <ul className="floors-list">
        {doProjeto.map((g, i) => {
              const floor = parseLayout(g.layoutJson).floor;
              const isGround = i === 0 && !floor;
              const vivos = aliveCount(g.id);
              return (
                <li key={g.id}>
                  <div
                    className={`floors-row ${g.id === activeGroupId ? "is-active" : ""}`}
                    role="menuitem"
                    tabIndex={0}
                    onClick={() => {
                      setActiveGroup(g.id);
                      onClose();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setActiveGroup(g.id);
                        onClose();
                      }
                    }}
                  >
                    <span className="floors-name" data-tip={g.name}>
                      {g.name}
                    </span>
                    {isGround && <span className="floors-badge">chão</span>}
                    {floor?.kind === "isolated" && floor.branch && (
                      <span className="floors-badge floors-badge--branch" data-tip-wrap="" data-tip={floor.worktreePath}>
                        <GitBranch size={10} aria-hidden="true" />
                        {floor.branch}
                      </span>
                    )}
                    {floor?.kind === "plain" && (
                      <span className="floors-badge">sem git</span>
                    )}
                    {vivos > 0 && (
                      <span className="floors-alive" data-tip={`${vivos} terminal(is) vivo(s)`}>
                        {vivos}
                      </span>
                    )}
                    {floor && (
                      <span className="floors-actions">
                        {floor.hooks?.run.length ? (
                          <button
                            className="icon-btn"
                            data-tip="Rodar hooks do andar"
                            aria-label={`Rodar hooks de ${g.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void rodarHooks(g);
                            }}
                          >
                            <Play size={12} />
                          </button>
                        ) : null}
                        <button
                          className="icon-btn"
                          data-tip-wrap="" data-tip="Descarregar: suspender os terminais, mantendo o andar"
                          aria-label={`Descarregar ${g.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void descarregar(g);
                          }}
                        >
                          <Moon size={12} />
                        </button>
                        <button
                          className="icon-btn icon-btn--danger"
                          data-tip-wrap="" data-tip="Encerrar: remover o andar e o worktree (recusado se houver trabalho não commitado)"
                          aria-label={`Encerrar ${g.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void encerrar(g);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
      </ul>
      <button
        className="floors-new"
        onClick={() => {
          onClose();
          openModal("new-floor", { projectId: project.id });
        }}
      >
        <Plus size={12} aria-hidden="true" /> Criar andar…
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Criar andar…" modal
// ---------------------------------------------------------------------------

export function NewFloorModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as { projectId?: string } | null;

  const projects = useProjects((s) => s.projects);
  const project = projects.find((p) => p.id === payload?.projectId);
  const isRepo = useChanges((s) =>
    project ? (s.gitByProject[project.id]?.isRepo ?? true) : false,
  );

  const [nome, setNome] = useState("");
  const [branch, setBranch] = useState("");
  const [existente, setExistente] = useState(false);
  const [clonarChao, setClonarChao] = useState(true);
  const [semGit, setSemGit] = useState(!isRepo);
  const [setupTxt, setSetupTxt] = useState("");
  const [runTxt, setRunTxt] = useState("");
  const [teardownTxt, setTeardownTxt] = useState("");
  const [autoSetup, setAutoSetup] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!project) return null;

  const criar = async () => {
    const name = nome.trim();
    if (!name) {
      showToast("Dê um nome ao andar.", "error");
      return;
    }
    if (existente && !branch.trim()) {
      showToast("Informe a branch existente.", "error");
      return;
    }
    setBusy(true);
    try {
      const prov = await ipc.worktreeProvision({
        projectPath: project.path,
        name,
        branch: branch.trim() || null,
        existingBranch: existente,
        noGit: semGit,
      });

      const hooks: FloorHooks = {
        setup: parseHookLines(setupTxt),
        run: parseHookLines(runTxt),
        teardown: parseHookLines(teardownTxt),
        autoSetup,
      };
      const temHooks = hooks.setup.length || hooks.run.length || hooks.teardown.length;
      const floor: FloorMeta =
        prov.kind === "isolated"
          ? {
              kind: "isolated",
              branch: prov.branch ?? undefined,
              worktreePath: prov.path,
              ...(temHooks ? { hooks } : {}),
            }
          : { kind: "plain", ...(temHooks ? { hooks } : {}) };

      const s = useProjects.getState();
      const gid = s.addGroup(project.id, name, { layout: { floor } });

      if (clonarChao) {
        const chao = s
          .groupsOf(project.id)
          .filter((g) => g.id !== gid)
          .sort((a, b) => a.sort - b.sort)[0];
        if (chao) {
          // Same cards as the ground, cwd remapped to the worktree; nothing
          // spawns — terminals are born stopped and the user starts them at will.
          applyScore(serializeGroup(chao.id, name), gid, {
            cwd: prov.kind === "isolated" ? prov.path : project.path,
          });
        }
      }

      if (autoSetup && hooks.setup.length) {
        const grupo = useProjects.getState().groups.find((g) => g.id === gid);
        const r = await runHookList(
          prov.path,
          hooks.setup,
          floorHookEnv({
            floorName: grupo?.name ?? name,
            branch: prov.branch ?? undefined,
            floorPath: prov.path,
            rootPath: project.path,
            projectName: project.name,
          }),
        );
        if (!r.ok) showToast(`Setup do andar falhou: ${r.detail}`, "error");
      }

      showToast(
        prov.kind === "isolated"
          ? `Andar "${name}" criado na branch ${prov.branch}.`
          : `Andar "${name}" criado sem git — mesmo diretório do chão.`,
      );
      closeModal();
    } catch (e) {
      showToast(`Não consegui criar o andar: ${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Criar andar"
      onClose={closeModal}
      footer={
        <div className="modal-foot-row">
          <span className="hint grow">
            O andar vira um <code>git worktree</code> em{" "}
            <code>.yard\floors\…</code> — o chão continua intocado.
          </span>
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !nome.trim()}
            onClick={() => void criar()}
          >
            {busy ? "Criando…" : "Criar andar"}
          </button>
        </div>
      }
    >
      <div className="form">
        <label>
          Nome
          <input
            value={nome}
            placeholder="ex.: fix-login"
            onChange={(e) => setNome(e.target.value)}
          />
        </label>
        {!semGit && (
          <>
            <label>
              Branch {existente ? "existente" : "(opcional)"}
              <input
                value={branch}
                placeholder={existente ? "nome da branch" : "padrão: yard/<nome>"}
                onChange={(e) => setBranch(e.target.value)}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={existente}
                onChange={(e) => setExistente(e.target.checked)}
              />
              Usar uma branch que já existe (sem criar branch nova)
            </label>
          </>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={clonarChao}
            onChange={(e) => setClonarChao(e.target.checked)}
          />
          Clonar o layout do chão (terminais nascem parados, no cwd do andar)
        </label>
        {isRepo && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={semGit}
              onChange={(e) => setSemGit(e.target.checked)}
            />
            Sem git: só um grupo novo, no mesmo diretório do chão
          </label>
        )}
        <details className="floors-hooks">
          <summary>Hooks (opcional) — um comando por linha</summary>
          <label>
            Setup (na criação)
            <textarea
              rows={2}
              value={setupTxt}
              placeholder="ex.: npm ci"
              onChange={(e) => setSetupTxt(e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoSetup}
              onChange={(e) => setAutoSetup(e.target.checked)}
            />
            Rodar o setup automaticamente ao criar
          </label>
          <label>
            Run (botão ▶ no overview)
            <textarea
              rows={2}
              value={runTxt}
              placeholder="ex.: npm run dev"
              onChange={(e) => setRunTxt(e.target.value)}
            />
          </label>
          <label>
            Teardown (ao encerrar)
            <textarea
              rows={2}
              value={teardownTxt}
              onChange={(e) => setTeardownTxt(e.target.value)}
            />
          </label>
        </details>
      </div>
    </Modal>
  );
}
