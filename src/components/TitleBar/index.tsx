/**
 * Custom title bar (the window runs with `decorations: false`).
 *
 * `data-tauri-drag-region` is what makes the area draggable — without it
 * the undecorated window is stuck in place.
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  GitBranch,
  GitCompare,
  LayoutGrid,
  Maximize2,
  Minus,
  Minimize2,
  PanelLeft,
  Plus,
  Settings,
  X,
} from "lucide-react";

import { projectIcon } from "../../lib/projectStyle";
import { useChanges } from "../../stores/changesStore";
import { parseLayout, useProjects, type LayoutMode } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

const appWindow = getCurrentWindow();

const MODOS: { id: LayoutMode; label: string; dica: string }[] = [
  { id: "auto", label: "Auto", dica: "Automático: a grade segue os painéis usados" },
  { id: "grid", label: "Grade", dica: "Grade fixa, com o número de painéis ao lado" },
  { id: "spotlight", label: "Holofote", dica: "Um painel grande, os outros ao lado" },
  {
    id: "canvas",
    label: "Canvas",
    dica: "Canvas infinito: terminais soltos, desenho à mão, notas e conexões",
  },
];

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const openModal = useUI((s) => s.openModal);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const groups = useProjects((s) => s.groups);
  const updateLayout = useProjects((s) => s.updateLayout);
  const projectOfGroup = useProjects((s) => s.projectOfGroup);
  const changesOpen = useChanges((s) => s.open);
  const toggleChanges = useChanges((s) => s.toggle);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const changedCount = useChanges((s) =>
    activeProjectId ? (s.gitByProject[activeProjectId]?.files.length ?? 0) : 0,
  );

  const group = groups.find((g) => g.id === activeGroupId);
  const project = activeGroupId ? projectOfGroup(activeGroupId) : undefined;
  const layout = group ? parseLayout(group.layoutJson) : null;
  const floor = layout?.floor;
  const ProjectIcon = projectIcon(project?.icon);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then(setMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      {/* macOS traffic lights: close / minimize / zoom. The glyphs appear
          when the group is hovered or focused, like the original. */}
      <div className="traffic">
        <button
          className="traffic-btn traffic-btn--close"
          onClick={() => void appWindow.close()}
          data-tip="Fechar"
          data-tip-at="left"
          aria-label="Fechar"
        >
          <X strokeWidth={3.5} aria-hidden="true" />
        </button>
        <button
          className="traffic-btn traffic-btn--min"
          onClick={() => void appWindow.minimize()}
          data-tip="Minimizar"
          aria-label="Minimizar"
        >
          <Minus strokeWidth={3.5} aria-hidden="true" />
        </button>
        <button
          className="traffic-btn traffic-btn--max"
          onClick={() => void appWindow.toggleMaximize()}
          data-tip={maximized ? "Restaurar" : "Ampliar"}
          aria-label={maximized ? "Restaurar" : "Ampliar"}
        >
          {maximized ? (
            <Minimize2 strokeWidth={3.5} aria-hidden="true" />
          ) : (
            <Maximize2 strokeWidth={3.5} aria-hidden="true" />
          )}
        </button>
      </div>
      <div className="titlebar-left" data-tauri-drag-region>
        <button
          className="icon-btn"
          data-tip="Mostrar ou esconder a barra lateral (Ctrl+B)"
          data-tip-at="left"
          aria-label="Mostrar ou esconder a barra lateral"
          aria-pressed={sidebarOpen}
          onClick={toggleSidebar}
        >
          <PanelLeft size={14} />
        </button>
        <span className="brand" data-tauri-drag-region>
          <span className="brand-mark" data-tauri-drag-region aria-hidden="true">
            Y
          </span>
          Yard
        </span>
        {project && (
          <span
            className="crumb"
            data-tauri-drag-region
            data-tip={project.path}
            data-tip-at="left"
          >
            <ProjectIcon
              size={12}
              className="crumb-icon"
              style={project.color ? { color: project.color } : undefined}
              aria-hidden="true"
            />
            <span className="crumb-project">{project.name}</span>
            {group && (
              <>
                <span className="crumb-sep" aria-hidden="true">
                  ›
                </span>
                <span className="crumb-group">{group.name}</span>
                {floor?.kind === "isolated" && floor.branch && (
                  <span
                    className="crumb-branch"
                    data-tip={`Andar isolado — worktree em ${floor.worktreePath ?? "?"}`}
                  >
                    <GitBranch size={10} aria-hidden="true" />
                    {floor.branch}
                  </span>
                )}
              </>
            )}
          </span>
        )}
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        {activeGroupId && layout && (
          <div className="layout-switch" role="group" aria-label="Layout do grupo">
            <LayoutGrid size={13} aria-hidden="true" />
            {MODOS.map((m) => (
              <button
                key={m.id}
                className={layout.mode === m.id ? "is-active" : ""}
                aria-pressed={layout.mode === m.id}
                onClick={() => updateLayout(activeGroupId, { mode: m.id })}
                data-tip={m.dica}
              >
                {m.label}
              </button>
            ))}
            {(layout.mode === "grid" || layout.mode === "spotlight") && (
              /* The <select> is a replaced element (no ::after): the balloon
                 lives on the surrounding span. */
              <span data-tip="Número de painéis" style={{ display: "inline-flex" }}>
                <select
                  value={layout.panelCount}
                  aria-label="Número de painéis"
                  onChange={(e) =>
                    updateLayout(activeGroupId, {
                      panelCount: Number(e.target.value),
                    })
                  }
                >
                  {[1, 2, 3, 4, 6].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? "painel" : "painéis"}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="titlebar-right">
        <button
          className="btn btn--ghost"
          data-tip="Novo terminal (Ctrl+T)"
          onClick={() => openModal("new-terminal")}
        >
          <Plus size={13} aria-hidden="true" /> Terminal
        </button>
        <button
          className={`icon-btn changes-toggle ${changesOpen ? "is-active" : ""}`}
          data-tip="Arquivos e alterações (Ctrl+Shift+D)"
          data-tip-at="right"
          aria-label={
            changedCount > 0
              ? `Arquivos e alterações (${changedCount} alterados)`
              : "Arquivos e alterações"
          }
          aria-pressed={changesOpen}
          onClick={toggleChanges}
        >
          <GitCompare size={14} />
          {changedCount > 0 && (
            <span className="changes-toggle-badge" aria-hidden="true">
              {changedCount > 99 ? "99+" : changedCount}
            </span>
          )}
        </button>
        <button
          className="icon-btn"
          data-tip="Preferências (Ctrl+Shift+P)"
          data-tip-at="right"
          aria-label="Preferências"
          onClick={() => openModal("preferences")}
        >
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}
