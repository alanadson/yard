/**
 * Floors: overview and creation.
 *
 * A floor is a sibling group of the ground with its own git worktree
 * (`.yard/floors/<slug>`), its own canvas and an isolated cwd. The button
 * sits in the bottom-right corner of the workspace (next to the zoom control
 * in canvas mode); the overview lists ground + floors with a branch badge and
 * allows landing (merge onto the ground), comparing floors, fan-out of one
 * prompt across N agents, unloading (suspending the PTYs) or closing.
 *
 * Nothing here kills a process on its own: closing goes through
 * `closeGroup` (lifecycle) and unloading uses `suspend_group`, which
 * preserves scrollback and session.
 */
import { useEffect, useRef, useState } from "react";
import "./floors.css";
import {
  Columns2,
  GitBranch,
  GitMerge,
  Layers,
  Moon,
  Play,
  Plus,
  Split,
  Trash2,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { copyText } from "../../lib/clipboard";
import { floorRowMenu } from "../../lib/floorMenu";
import { liveIdsOf } from "../../lib/floorClose";
import { floorHookEnv, isIsolatedFloor, type FloorMeta } from "../../lib/floors";
import { ipc, type GroupRow, type ProjectRow } from "../../lib/ipc";
import { parseLayout, useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import { runFloorHooks } from "../../lib/floorHooks";

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
  /** Where focus goes back to when the popover closes with Esc. */
  const buttonRef = useRef<HTMLButtonElement>(null);

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
    // A popover that only closes by clicking outside is a trap for anyone on
    // the keyboard: Esc is the other half of the contract.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!project) return null;

  return (
    <div className={`floors-ctl floors-ctl--${variant}`} ref={rootRef}>
      {open && <FloorsPopover project={project} onClose={() => setOpen(false)} />}
      <button
        ref={buttonRef}
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
  const runtimes = useTerminals((s) => s.byId);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const setActiveGroup = useProjects((s) => s.setActiveGroup);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);

  const ofProject = groups
    .filter((g) => g.projectId === project.id)
    .sort((a, b) => a.sort - b.sort);

  /**
   * Which row is mid-operation. "Criar andar" already had this; the three row
   * actions did not, and they are all slow and all repeatable: two clicks on
   * ▶ ran `npm run dev` twice in the same worktree, the second one fighting
   * the first for the port.
   */
  const [occupied, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(
    null,
  );
  const withLock = (g: GroupRow, fn: () => Promise<void>) => async () => {
    if (occupied) return;
    setBusy(g.id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  // The runtime is what knows who is alive (§4.3). `TerminalRow.alive` is the
  // persisted intent — using it here counted already-terminated processes and
  // sent `suspend` to them, which came back as a "failure".
  const unload = async (g: GroupRow) => {
    const ids = liveIdsOf(g.id);
    if (ids.length === 0) {
      showToast("Nenhum terminal vivo neste andar.");
      return;
    }
    const failures = await ipc.suspendGroup(ids);
    showToast(
      failures.length
        ? `Andar descarregado com ${failures.length} falha(s).`
        : `Andar "${g.name}" descarregado — sessões preservadas.`,
    );
  };

  // A single dialog, with the branch as a checkbox — it used to be two native
  // ones in sequence, and the second changed the contract of the first with
  // the list of costs already off screen (see `CloseFloorModal`).
  const closeIt = (g: GroupRow) => {
    if (!parseLayout(g.layoutJson).floor) return;
    onClose();
    openModal("close-floor", { project, group: g });
  };

  const runHooks = async (g: GroupRow) => {
    const floor = parseLayout(g.layoutJson).floor;
    if (!floor?.hooks?.run.length) return;
    const cwd = floor.worktreePath ?? project.path;
    showToast(`Rodando hooks de "${g.name}"…`);
    const r = await runFloorHooks(cwd, floor.hooks.run, hookEnvFor(g, floor, project));
    showToast(r.ok ? `Hooks de "${g.name}" concluídos.` : `Hook falhou: ${r.detail}`, r.ok ? "info" : "error");
  };

  return (
    // `role="group"`, not `role="menu"`: the rows carry their own action
    // buttons, and a menu whose items contain buttons is a broken menu — the
    // shape here is a list of choices, which is what this says.
    <div className="floors-pop" role="group" aria-label="Andares do projeto">
      <div className="floors-pop-head">
        <span>Andares — {project.name}</span>
      </div>
      <ul className="floors-list">
        {ofProject.map((g, i) => {
              const floor = parseLayout(g.layoutJson).floor;
              const isGround = i === 0 && !floor;
              const aliveCount = terminals.filter(
                (t) => t.groupId === g.id && isLive(runtimes[t.id]),
              ).length;
              return (
                <li key={g.id}>
                  <div
                    className={`floors-row ${g.id === activeGroupId ? "is-active" : ""}`}
                    // The row's icon buttons only have a tooltip; the menu is
                    // where the same actions have a name — and where the two
                    // the row could never fit go (copy branch and worktree).
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({
                        anchor: { x: e.clientX, y: e.clientY },
                        entries: floorRowMenu(
                          {
                            isGround,
                            floor,
                            liveCount: aliveCount,
                            busy: occupied !== null,
                          },
                          {
                            goTo: () => {
                              setActiveGroup(g.id);
                              onClose();
                            },
                            land: () => {
                              onClose();
                              openModal("land-floor", { project, group: g });
                            },
                            runHooks: () => void withLock(g, () => runHooks(g))(),
                            unload: () => void withLock(g, () => unload(g))(),
                            copy: (text) => {
                              void copyText(text).then((ok) =>
                                showToast(
                                  ok ? "Copiado." : "Não consegui copiar.",
                                  ok ? "info" : "error",
                                ),
                              );
                            },
                            close: () => closeIt(g),
                          },
                        ),
                      });
                    }}
                  >
                    {/* A real button: Enter and Space both work, and the
                        action buttons beside it are siblings, not children. */}
                    <button
                      type="button"
                      className="floors-pick"
                      aria-current={g.id === activeGroupId}
                      onClick={() => {
                        setActiveGroup(g.id);
                        onClose();
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
                      {aliveCount > 0 && (
                        <span
                          className="floors-alive"
                          data-tip={`${aliveCount} terminal(is) vivo(s)`}
                          role="img"
                          aria-label={`${aliveCount} terminal(is) vivo(s)`}
                        >
                          {aliveCount}
                        </span>
                      )}
                    </button>
                    {floor && (
                      <span className="floors-actions">
                        {isIsolatedFloor(floor) && (
                          <button
                            className="icon-btn"
                            data-tip="Aterrissar este andar no chão"
                            aria-label={`Aterrissar ${g.name}`}
                            disabled={occupied !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              onClose();
                              openModal("land-floor", { project, group: g });
                            }}
                          >
                            <GitMerge size={12} />
                          </button>
                        )}
                        {floor.hooks?.run.length ? (
                          <button
                            className={`icon-btn ${occupied === g.id ? "is-busy" : ""}`}
                            data-tip="Rodar hooks do andar"
                            aria-label={`Rodar hooks de ${g.name}`}
                            aria-busy={occupied === g.id}
                            disabled={occupied !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              void withLock(g, () => runHooks(g))();
                            }}
                          >
                            <Play size={12} />
                          </button>
                        ) : null}
                        <button
                          className={`icon-btn ${occupied === g.id ? "is-busy" : ""}`}
                          data-tip-wrap="" data-tip="Descarregar: suspender os terminais, mantendo o andar"
                          aria-label={`Descarregar ${g.name}`}
                          aria-busy={occupied === g.id}
                          disabled={occupied !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            void withLock(g, () => unload(g))();
                          }}
                        >
                          <Moon size={12} />
                        </button>
                        <button
                          className="icon-btn icon-btn--danger"
                          data-tip-wrap="" data-tip="Encerrar: remover o andar e o worktree (recusado se houver trabalho não commitado)"
                          aria-label={`Encerrar ${g.name}`}
                          disabled={occupied !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            closeIt(g);
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
      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          items={menu.entries}
          onClose={() => setMenu(null)}
        />
      )}
      <button
        className="floors-new"
        onClick={() => {
          onClose();
          openModal("new-task", { projectId: project.id });
        }}
      >
        <Split size={12} aria-hidden="true" /> Nova tarefa…
      </button>
      <button
        className="floors-new"
        onClick={() => {
          onClose();
          openModal("compare-floors", { projectId: project.id });
        }}
      >
        <Columns2 size={12} aria-hidden="true" /> Comparar andares…
      </button>
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
