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
import { groundBranchOf } from "../../lib/destination";
import { GROUND_FLOOR, floorHookEnv, groupLabel, isIsolatedFloor, type FloorMeta } from "../../lib/floors";
import { publishBadge, publishStateOf } from "../../lib/floorSync";
import { useWorktrees } from "../../stores/worktreesStore";
import { ipc, type GroupRow, type ProjectRow, type ScmBranch } from "../../lib/ipc";
import { parseLayout, useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import { runFloorHooks } from "../../lib/floorHooks";
import { useT } from "../../hooks/useT";

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
 * The button lives beside the canvas camera, and nowhere else
 * (`place.ts` holds that rule, and the grid asks it). It must be cheap when
 * closed: it subscribes to a project row and a *number*, never to the group
 * or terminal arrays. Those change identity on every layout write — including
 * a canvas commit, which happens per keystroke inside a note.
 */
export function FloorsControl({ groupId }: { groupId: string }) {
  const t = useT();
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
    <div className="floors-ctl" ref={rootRef}>
      {open && <FloorsPopover project={project} onClose={() => setOpen(false)} />}
      <button
        ref={buttonRef}
        className={`floors-btn ${open ? "is-active" : ""}`}
        data-tip-side="top" data-tip-wrap="" data-tip={t("Frentes: cópias isoladas do repositório, cada uma com o próprio canvas")}
        aria-label={t("Frentes")}
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
  const t = useT();
  const groups = useProjects((s) => s.groups);
  const terminals = useProjects((s) => s.terminals);
  const runtimes = useTerminals((s) => s.byId);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const groundBranch = useWorktrees((s) => groundBranchOf(s.of(project.id), project.path));
  const setActiveGroup = useProjects((s) => s.setActiveGroup);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);

  /**
   * What the server knows about this project's branches.
   *
   * A front is born with `--no-track` and nothing here ever pushes, so
   * "a frente existe" and "o trabalho da frente existe em algum lugar além
   * deste disco" are different facts, and only the Controle tab knew the
   * second one, for whichever repository the bench happened to be pointed at.
   * Two cheap reads on open (`for-each-ref` + `status`) put it on the rows.
   */
  const [sync, setSync] = useState<{ branches: ScmBranch[]; hasRemote: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [info, branches] = await Promise.all([
          ipc.scmInfo(project.path),
          ipc.scmBranches(project.path),
        ]);
        if (alive) setSync({ branches, hasRemote: info.remotes.length > 0 });
      } catch {
        // A folder with no repository has nothing to say here, and this
        // popover is not the screen that would tell anybody about it.
      }
    })();
    return () => {
      alive = false;
    };
  }, [project.path]);

  const ofProject = groups
    .filter((g) => g.projectId === project.id)
    .sort((a, b) => a.sort - b.sort);

  /**
   * Which row is mid-operation. "Abrir frente" already had this; the three row
   * actions did not, and they are all slow and all repeatable: two clicks on
   * ▶ ran `npm run dev` twice in the same worktree, the second one fighting
   * the first for the port.
   */
  const [occupied, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(
    null,
  );
  const withLock = (g: GroupRow, fn: () => Promise<void>) => async () => { // i18n-ok
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
      showToast(t("Nenhum terminal vivo nesta frente."));
      return;
    }
    const failures = await ipc.suspendGroup(ids);
    showToast(
      failures.length
        ? t("Frente descarregada com {n} falha(s).", { n: failures.length })
        : t('Frente "{name}" descarregada — sessões preservadas.', { name: g.name }),
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
    showToast(t('Rodando hooks de "{name}"…', { name: g.name }));
    const r = await runFloorHooks(cwd, floor.hooks.run, hookEnvFor(g, floor, project));
    showToast(
      r.ok ? t('Hooks de "{name}" concluídos.', { name: g.name }) : t("Hook falhou: {detail}", { detail: r.detail }),
      r.ok ? "info" : "error",
    );
  };

  return (
    // `role="group"`, not `role="menu"`: the rows carry their own action
    // buttons, and a menu whose items contain buttons is a broken menu — the
    // shape here is a list of choices, which is what this says.
    <div className="floors-pop" role="group" aria-label={t("Frentes do projeto")}>
      <div className="floors-pop-head">
        <span>{t("Frentes — {name}", { name: project.name })}</span>
      </div>
      <ul className="floors-list">
        {ofProject.map((g, i) => {
              const floor = parseLayout(g.layoutJson).floor;
              const isGround = i === 0 && !floor;
              // Same name the sidebar and the title bar print: the ground is
              // the branch checked out at the project root.
              const label = groupLabel({
                name: g.name,
                floor: floor ?? GROUND_FLOOR,
                groundBranch,
              });
              const aliveCount = terminals.filter(
                (t) => t.groupId === g.id && isLive(runtimes[t.id]),
              ).length;
              // The ground answers for its own branch too: landing a front
              // merges locally, so the row that owes the server commits after
              // an "aterrissar" is this one.
              const rowBranch = floor?.kind === "isolated" ? floor.branch : isGround ? groundBranch : null;
              const publish = publishBadge(
                publishStateOf(sync?.branches, rowBranch, sync?.hasRemote ?? false),
                rowBranch ?? "",
              );
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
                                  ok ? t("Copiado.") : t("Não consegui copiar."),
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
                      <span className="floors-name" data-tip={label}>
                        {label}
                      </span>
                      {isGround && <span className="floors-badge">{t("chão")}</span>}
                      {floor?.kind === "isolated" && floor.branch && (
                        <span className="floors-badge floors-badge--branch" data-tip-wrap="" data-tip={floor.worktreePath}>
                          <GitBranch size={10} aria-hidden="true" />
                          {floor.branch}
                        </span>
                      )}
                      {floor?.kind === "plain" && (
                        <span className="floors-badge">{t("sem git")}</span>
                      )}
                      {publish && (
                        <span
                          className={`floors-badge floors-badge--${publish.tone}`}
                          data-tip-wrap=""
                          data-tip={publish.tip}
                        >
                          {publish.label}
                        </span>
                      )}
                      {aliveCount > 0 && (
                        <span
                          className="floors-alive"
                          data-tip={t("{n} terminal(is) vivo(s)", { n: aliveCount })}
                          role="img"
                          aria-label={t("{n} terminal(is) vivo(s)", { n: aliveCount })}
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
                            data-tip={t("Aterrissar esta frente no chão")}
                            aria-label={t("Aterrissar {name}", { name: g.name })}
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
                            data-tip={t("Rodar hooks da frente")}
                            aria-label={t("Rodar hooks de {name}", { name: g.name })}
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
                          data-tip-wrap="" data-tip={t("Descarregar: suspender os terminais, mantendo a frente")}
                          aria-label={t("Descarregar {name}", { name: g.name })}
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
                          data-tip-wrap="" data-tip={t("Encerrar: remover a frente e o worktree (recusado se houver trabalho não commitado)")}
                          aria-label={t("Encerrar {name}", { name: g.name })}
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
        <Split size={12} aria-hidden="true" /> {t("Nova tarefa…")}
      </button>
      <button
        className="floors-new"
        onClick={() => {
          onClose();
          openModal("compare-floors", { projectId: project.id });
        }}
      >
        <Columns2 size={12} aria-hidden="true" /> {t("Comparar frentes…")}
      </button>
      <button
        className="floors-new"
        onClick={() => {
          onClose();
          openModal("new-floor", { projectId: project.id });
        }}
      >
        <Plus size={12} aria-hidden="true" /> {t("Abrir frente…")}
      </button>
    </div>
  );
}
