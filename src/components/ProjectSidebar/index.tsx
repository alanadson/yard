/**
 * Tree of projects -> groups -> terminals, plus the resource HUD in the footer.
 *
 * Right-click (or the kebab on hover) opens each row's menu: rename,
 * delete, suspend, new CLI, etc. Rename is in-place — no modal.
 *
 * The tree is also the state map: process-state dot, white unread-output
 * dot, green agent-finished dot, and a highlight on the CLI that is
 * receiving keystrokes.
 */
import { useCallback, useState, type MouseEvent } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  History,
  Layers,
  MoreVertical,
  Palette,
  PauseCircle,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  Bot,
  Music,
  Trash2,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { InlineRename } from "../ContextMenu/InlineRename";
import { Resizer } from "../Resizer";
import { ipc } from "../../lib/ipc";
import { closeGroup, closeProject } from "../../lib/lifecycle";
import { projectIcon } from "../../lib/projectStyle";
import { terminalActionEntries } from "../../lib/terminalMenu";
import { baseName } from "../../lib/terminals";
import { useAction } from "../../hooks/useAction";
import { useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import {
  useUI,
  DEFAULT_PREFS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "../../stores/uiStore";

type TreeKind = "project" | "group" | "terminal";

interface MenuState {
  kind: TreeKind;
  id: string;
  anchor: MenuAnchor;
}

interface RenameState {
  kind: TreeKind;
  id: string;
}

export function ProjectSidebar() {
  // One subscription per field. Destructuring the whole store used to
  // re-render this entire tree on *any* write — including `updateCanvas`,
  // which fires on every keystroke inside a canvas note. Zustand's actions
  // are stable references, so subscribing to them costs nothing.
  const projects = useProjects((s) => s.projects);
  const groups = useProjects((s) => s.groups);
  const terminals = useProjects((s) => s.terminals);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const setActiveGroup = useProjects((s) => s.setActiveGroup);
  const addGroup = useProjects((s) => s.addGroup);
  const renameProject = useProjects((s) => s.renameProject);
  const renameGroup = useProjects((s) => s.renameGroup);
  const updateTerminal = useProjects((s) => s.updateTerminal);
  const moveGroup = useProjects((s) => s.moveGroup);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const width = useUI((s) => s.prefs.sidebarWidth);
  const setPref = useUI((s) => s.setPref);
  const setPrefLocal = useUI((s) => s.setPrefLocal);
  const runtimes = useTerminals((s) => s.byId);
  const act = useAction();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);

  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const openMenu = (
    e: MouseEvent,
    kind: TreeKind,
    id: string,
    fromButton = false,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (fromButton) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ kind, id, anchor: { x: r.left, y: r.bottom + 4 } });
    } else {
      setMenu({ kind, id, anchor: { x: e.clientX, y: e.clientY } });
    }
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const beginRename = (kind: TreeKind, id: string) => {
    setMenu(null);
    setRenaming({ kind, id });
  };

  const commitRename = (next: string) => {
    if (!renaming) return;
    if (renaming.kind === "project") renameProject(renaming.id, next);
    else if (renaming.kind === "group") renameGroup(renaming.id, next);
    else updateTerminal(renaming.id, { title: next });
    setRenaming(null);
  };

  const runningIds = (groupId: string) =>
    terminals
      .filter((t) => t.groupId === groupId)
      .map((t) => t.id)
      .filter((id) => runtimes[id]?.state === "running");

  const suspendGroup = async (groupId: string) => {
    const ids = runningIds(groupId);
    if (ids.length === 0) {
      showToast("Nenhum terminal rodando neste grupo.");
      return;
    }
    const falhas = await ipc.suspendGroup(ids);
    showToast(
      falhas.length
        ? `${ids.length - falhas.length} suspensos, ${falhas.length} falharam.`
        : `${ids.length} terminais suspensos — RAM liberada.`,
    );
  };

  const novaCli = (groupId: string) => {
    setActiveGroup(groupId);
    openModal("new-terminal", { groupId });
  };

  const confirmDeleteGroup = async (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const clis = terminals.filter((t) => t.groupId === groupId);
    const vivos = clis.filter((t) => isLive(runtimes[t.id])).length;
    const detalhe =
      vivos > 0
        ? `${vivos} CLI(s) ainda rodando. Excluir encerra os processos.`
        : clis.length > 0
          ? `O grupo tem ${clis.length} CLI(s).`
          : "O grupo está vazio.";
    const ok = await ask(`Excluir o grupo “${group.name}”? ${detalhe}`, {
      title: "Excluir grupo",
      kind: "warning",
    });
    if (!ok) return;
    await closeGroup(groupId);
  };

  const confirmDeleteProject = async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const gids = new Set(
      groups.filter((g) => g.projectId === projectId).map((g) => g.id),
    );
    const clis = terminals.filter((t) => gids.has(t.groupId));
    const vivos = clis.filter((t) => isLive(runtimes[t.id])).length;
    const ok = await ask(
      vivos > 0
        ? `Remover “${project.name}”? ${vivos} CLI(s) ainda rodando serão encerradas.`
        : `Remover o projeto “${project.name}” da barra? A pasta no disco permanece.`,
      { title: "Remover projeto", kind: "warning" },
    );
    if (!ok) return;
    await closeProject(projectId);
  };

  const menuItems = (): MenuEntry[] => {
    if (!menu) return [];

    if (menu.kind === "project") {
      const project = projects.find((p) => p.id === menu.id);
      if (!project) return [];
      return [
        {
          id: "rename",
          label: "Renomear",
          icon: <Pencil size={13} />,
          onSelect: () => beginRename("project", project.id),
        },
        {
          id: "style",
          label: "Personalizar…",
          icon: <Palette size={13} />,
          onSelect: () => openModal("project-style", { projectId: project.id }),
        },
        {
          id: "new-group",
          label: "Novo grupo",
          icon: <Plus size={13} />,
          onSelect: () => addGroup(project.id),
        },
        { kind: "sep" },
        {
          id: "explorer",
          label: "Abrir no Explorer",
          icon: <FolderOpen size={13} />,
          onSelect: () => void ipc.revealPath(project.path),
        },
        {
          id: "sessions",
          label: "Sessões de agentes…",
          icon: <History size={13} />,
          onSelect: () => openModal("sessions", { projectPath: project.path }),
        },
        {
          id: "scores",
          label: "Partituras…",
          icon: <Music size={13} />,
          onSelect: () => openModal("scores", { projectId: project.id }),
        },
        { kind: "sep" },
        {
          id: "delete",
          label: "Remover projeto",
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => void confirmDeleteProject(project.id),
        },
      ];
    }

    if (menu.kind === "group") {
      const group = groups.find((g) => g.id === menu.id);
      if (!group) return [];
      const siblings = groups
        .filter((g) => g.projectId === group.projectId)
        .sort((a, b) => a.sort - b.sort);
      const idx = siblings.findIndex((g) => g.id === group.id);
      const vivos = runningIds(group.id).length;
      return [
        {
          id: "rename",
          label: "Renomear",
          icon: <Pencil size={13} />,
          onSelect: () => beginRename("group", group.id),
        },
        {
          id: "new-cli",
          label: "Nova CLI…",
          icon: <TerminalIcon size={13} />,
          shortcut: "Ctrl+T",
          onSelect: () => novaCli(group.id),
        },
        {
          id: "new-group",
          label: "Novo grupo",
          icon: <Plus size={13} />,
          onSelect: () => addGroup(group.projectId),
        },
        {
          id: "scores",
          label: "Partituras…",
          icon: <Music size={13} />,
          onSelect: () =>
            openModal("scores", { groupId: group.id, projectId: group.projectId }),
        },
        { kind: "sep" },
        {
          id: "up",
          label: "Mover para cima",
          icon: <ArrowUp size={13} />,
          disabled: idx <= 0,
          onSelect: () => moveGroup(group.id, -1),
        },
        {
          id: "down",
          label: "Mover para baixo",
          icon: <ArrowDown size={13} />,
          disabled: idx < 0 || idx >= siblings.length - 1,
          onSelect: () => moveGroup(group.id, 1),
        },
        { kind: "sep" },
        {
          id: "suspend",
          label: vivos > 0 ? `Suspender grupo (${vivos})` : "Suspender grupo",
          icon: <PauseCircle size={13} />,
          disabled: vivos === 0,
          onSelect: () => void suspendGroup(group.id),
        },
        {
          id: "delete",
          label: "Excluir grupo",
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => void confirmDeleteGroup(group.id),
        },
      ];
    }

    const t = terminals.find((x) => x.id === menu.id);
    if (!t) return [];
    return terminalActionEntries({
      id: t.id,
      running: isLive(runtimes[t.id]),
      run: act,
      onRename: () => beginRename("terminal", t.id),
    });
  };

  return (
    <aside
      className="sidebar"
      style={{ width }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="sidebar-header">
        <span>Projetos</span>
        <button
          className="icon-btn"
          data-tip="Adicionar projeto"
          aria-label="Adicionar projeto"
          onClick={() => openModal("new-project")}
        >
          <FolderPlus size={14} />
        </button>
      </div>

      <div className="sidebar-tree">
        {projects.length === 0 && (
          <div className="sidebar-empty">
            <p>
              Um projeto é uma pasta do disco. É dela que saem o diretório de
              trabalho das CLIs e as sessões que os agentes já gravaram.
            </p>
            <button
              className="btn btn--primary"
              onClick={() => openModal("new-project")}
            >
              <FolderPlus size={13} /> Adicionar pasta
            </button>
          </div>
        )}

        {projects.map((project) => {
          const projectGroups = groups
            .filter((g) => g.projectId === project.id)
            .sort((a, b) => a.sort - b.sort);
          const isCollapsed = collapsed[project.id];
          const projectMenuOpen =
            menu?.kind === "project" && menu.id === project.id;
          const ProjectIcon = projectIcon(project.icon);
          return (
            <div key={project.id} className="tree-project">
              <div
                className={`tree-row tree-row--project ${projectMenuOpen ? "is-menu-open" : ""}`}
                onContextMenu={(e) => openMenu(e, "project", project.id)}
              >
                <button
                  className="tree-toggle"
                  aria-expanded={!isCollapsed}
                  aria-label={
                    isCollapsed
                      ? `Expandir ${project.name}`
                      : `Recolher ${project.name}`
                  }
                  onClick={() => toggle(project.id)}
                >
                  {isCollapsed ? (
                    <ChevronRight size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </button>
                <ProjectIcon
                  size={13}
                  className="tree-icon tree-icon--project"
                  style={project.color ? { color: project.color } : undefined}
                  aria-hidden="true"
                />
                {renaming?.kind === "project" && renaming.id === project.id ? (
                  <InlineRename
                    value={project.name}
                    onCommit={commitRename}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span
                    className="tree-label"
                    data-tip-at="left" data-tip-wrap="" data-tip={project.path}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      beginRename("project", project.id);
                    }}
                  >
                    {project.name}
                  </span>
                )}
                <button
                  className="icon-btn"
                  data-tip-at="right" data-tip="Novo grupo"
                  aria-label={`Novo grupo em ${project.name}`}
                  onClick={() => addGroup(project.id)}
                >
                  <Plus size={13} />
                </button>
                <button
                  className="icon-btn"
                  data-tip-at="right" data-tip="Mais ações"
                  aria-label={`Mais ações de ${project.name}`}
                  onClick={(e) => openMenu(e, "project", project.id, true)}
                >
                  <MoreVertical size={13} />
                </button>
              </div>

              {!isCollapsed &&
                projectGroups.map((group) => {
                  const groupTerminals = terminals
                    .filter((t) => t.groupId === group.id)
                    .sort((a, b) => a.sort - b.sort);
                  const running = groupTerminals.filter(
                    (t) => runtimes[t.id]?.state === "running",
                  ).length;
                  const groupMenuOpen =
                    menu?.kind === "group" && menu.id === group.id;
                  const groupCollapsed = collapsed[group.id];
                  return (
                    <div key={group.id} className="tree-group">
                      <div
                        className={`tree-row tree-row--group ${
                          group.id === activeGroupId ? "is-active" : ""
                        } ${groupMenuOpen ? "is-menu-open" : ""}`}
                        onClick={() => setActiveGroup(group.id)}
                        onContextMenu={(e) => {
                          setActiveGroup(group.id);
                          openMenu(e, "group", group.id);
                        }}
                        data-tip-wrap="" data-tip="Botão direito para ações"
                      >
                        {groupTerminals.length > 0 ? (
                          <button
                            className="tree-toggle"
                            aria-expanded={!groupCollapsed}
                            aria-label={
                              groupCollapsed
                                ? `Expandir ${group.name}`
                                : `Recolher ${group.name}`
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(group.id);
                            }}
                          >
                            {groupCollapsed ? (
                              <ChevronRight size={12} />
                            ) : (
                              <ChevronDown size={12} />
                            )}
                          </button>
                        ) : (
                          <Layers size={12} className="tree-icon" />
                        )}
                        {renaming?.kind === "group" && renaming.id === group.id ? (
                          <InlineRename
                            value={group.name}
                            onCommit={commitRename}
                            onCancel={() => setRenaming(null)}
                          />
                        ) : (
                          <span
                            className="tree-label"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              beginRename("group", group.id);
                            }}
                          >
                            {group.name}
                          </span>
                        )}
                        {running > 0 && (
                          <span
                            className="pill"
                            data-tip-wrap="" data-tip={`${running} rodando neste grupo`}
                          >
                            {running}
                          </span>
                        )}
                        <button
                          className="icon-btn"
                          data-tip-at="right" data-tip="Nova CLI neste grupo"
                          aria-label={`Nova CLI em ${group.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            novaCli(group.id);
                          }}
                        >
                          <Plus size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          data-tip-at="right" data-tip="Mais ações"
                          aria-label={`Mais ações de ${group.name}`}
                          onClick={(e) => {
                            setActiveGroup(group.id);
                            openMenu(e, "group", group.id, true);
                          }}
                        >
                          <MoreVertical size={13} />
                        </button>
                      </div>

                      {groupTerminals.length === 0 && (
                        <div className="tree-empty">
                          Sem CLIs —{" "}
                          <button onClick={() => novaCli(group.id)}>
                            abrir uma
                          </button>
                        </div>
                      )}

                      {!groupCollapsed &&
                        groupTerminals.map((t) => {
                          const rt = runtimes[t.id];
                          const termMenuOpen =
                            menu?.kind === "terminal" && menu.id === t.id;
                          const label = baseName(t);
                          const abrir = () => {
                            setActiveGroup(group.id);
                            focusTerminal(t.id, t.slot);
                          };
                          return (
                            <div
                              key={t.id}
                              className={`tree-row tree-row--terminal ${
                                termMenuOpen ? "is-menu-open" : ""
                              } ${t.id === focusedTerminalId ? "is-focused" : ""}`}
                              onClick={abrir}
                              onContextMenu={(e) => {
                                abrir();
                                openMenu(e, "terminal", t.id);
                              }}
                              data-tip-at="left" data-tip-wrap="" data-tip={`${t.program} ${t.args.join(" ")}`.trim()}
                            >
                              <span
                                className={`dot dot--${rt?.state ?? "idle"}`}
                                data-tip={estadoLegivel(rt?.state)}
                              />
                              {t.kind === "agent" ? (
                                <Bot size={11} className="tree-icon" />
                              ) : (
                                <TerminalIcon size={11} className="tree-icon" />
                              )}
                              {renaming?.kind === "terminal" &&
                              renaming.id === t.id ? (
                                <InlineRename
                                  value={label}
                                  onCommit={commitRename}
                                  onCancel={() => setRenaming(null)}
                                />
                              ) : (
                                <span
                                  className="tree-label"
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    beginRename("terminal", t.id);
                                  }}
                                >
                                  {label}
                                </span>
                              )}
                              {rt?.finished && (
                                <span
                                  className="badge-finished"
                                  data-tip="Terminou de trabalhar"
                                />
                              )}
                              {rt?.unread && !rt.finished && (
                                <span
                                  className="badge-unread"
                                  data-tip="Saída nova ainda não vista"
                                />
                              )}
                              <button
                                className="icon-btn"
                                data-tip-at="right" data-tip="Mais ações"
                                aria-label={`Mais ações de ${label}`}
                                onClick={(e) => {
                                  abrir();
                                  openMenu(e, "terminal", t.id, true);
                                }}
                              >
                                <MoreVertical size={13} />
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      <ResourceHud />

      <Resizer
        side="right"
        width={width}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        defaultWidth={DEFAULT_PREFS.sidebarWidth}
        label="Largura da barra lateral"
        onResize={(w) => setPrefLocal("sidebarWidth", w)}
        onCommit={(w) => setPref("sidebarWidth", w)}
      />

      {menu && (
        <ContextMenu anchor={menu.anchor} items={menuItems()} onClose={closeMenu} />
      )}
    </aside>
  );
}

/**
 * Resource footer, in its own component on purpose: the numbers refresh on
 * every `resources://tick`, and inlined in the sidebar that tick re-rendered
 * the whole project tree just to move a progress bar.
 */
function ResourceHud() {
  const totalRssMb = useTerminals((s) => s.totalRssMb);
  const systemAvailableMb = useTerminals((s) => s.systemAvailableMb);
  const systemTotalMb = useTerminals((s) => s.systemTotalMb);

  const usoRam =
    systemTotalMb > 0
      ? Math.min(1, Math.max(0, 1 - systemAvailableMb / systemTotalMb))
      : 0;
  const nivelRam = usoRam > 0.92 ? "crit" : usoRam > 0.82 ? "warn" : "ok";

  return (
    <div className="sidebar-hud">
      <div className="hud-row">
        <span>Terminais</span>
        <strong data-tip-side="top" data-tip-wrap="" data-tip="RAM somada das árvores de processo das CLIs">
          {totalRssMb > 0 ? `${totalRssMb.toFixed(0)} MB` : "—"}
        </strong>
      </div>
      <div className="hud-row">
        <span>RAM livre</span>
        <strong>
          {systemAvailableMb > 0
            ? `${(systemAvailableMb / 1024).toFixed(1)} / ${(systemTotalMb / 1024).toFixed(0)} GB`
            : "—"}
        </strong>
      </div>
      {systemAvailableMb > 0 && (
        <div
          className="hud-bar"
          data-tip-side="top" data-tip-wrap="" data-tip={
            nivelRam === "ok"
              ? `${Math.round(usoRam * 100)}% da memória em uso`
              : `${Math.round(usoRam * 100)}% da memória em uso — suspenda grupos ociosos para liberar RAM`
          }
        >
          <div
            className={`hud-bar-fill ${nivelRam !== "ok" ? `hud-bar-fill--${nivelRam}` : ""}`}
            style={{ transform: `scaleX(${usoRam})` }}
          />
        </div>
      )}
    </div>
  );
}

function estadoLegivel(state?: string): string {
  switch (state) {
    case "running":
      return "Rodando";
    case "starting":
      return "Iniciando";
    case "exited":
      return "Encerrado";
    case "error":
      return "Falhou ao iniciar";
    default:
      return "Parado";
  }
}
