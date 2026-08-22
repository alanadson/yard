/**
 * Custom title bar (the window runs with `decorations: false`).
 *
 * `data-tauri-drag-region="deep"` is what makes the area draggable — without
 * it the undecorated window is stuck in place. The value is the whole story:
 * bare, Tauri only drags when the click lands *directly* on the element that
 * carries the attribute, so any empty gap inside a child is a dead spot —
 * `.titlebar-right` is `flex: 1` and eats all the slack of the right half,
 * and the bar dragged only from the middle leftwards. A bare attribute on a
 * child is worse still: it cuts the walk short and kills the drag over its
 * own children. `deep` covers the subtree, and the real controls — `<button>`,
 * `<input>`, anything with an interactive `role` — keep blocking the drag on
 * their own, no markup needed.
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Blocks,
  GitBranch,
  GitCompare,
  LayoutGrid,
  NotebookPen,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
} from "lucide-react";

import { projectIcon } from "../../lib/projectStyle";
import { AsyncDisposer } from "../../lib/disposables";
import { Select } from "../Select";
import { StatusChip } from "./StatusChip";
import { relevantTasks, useBench } from "../../stores/benchStore";
import { useChanges } from "../../stores/changesStore";
import { useNotes } from "../../stores/notesStore";
import { ContextMenu, type MenuAnchor } from "../ContextMenu";
import { titleBarMenu } from "../../lib/titleBarMenu";
import { parseLayout, useProjects, type LayoutMode } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

const appWindow = getCurrentWindow();

const MODES: { id: LayoutMode; label: string; tip: string }[] = [
  { id: "auto", label: "Auto", tip: "Automático: a grade segue os painéis usados" },
  { id: "grid", label: "Grade", tip: "Grade fixa, com o número de painéis ao lado" },
  { id: "spotlight", label: "Holofote", tip: "Um painel grande, os outros ao lado" },
  {
    id: "canvas",
    label: "Canvas",
    tip: "Canvas infinito: terminais soltos, desenho à mão, notas e conexões",
  },
];

const PANES = [1, 2, 3, 4, 6].map((n) => ({
  value: String(n),
  label: `${n} ${n === 1 ? "painel" : "painéis"}`,
}));

/* Window glyphs in the Windows shape: 10×10, 1px hairline strokes, like
   Segoe Fluent Icons. Drawn by hand — lucide's are rounded and much
   heavier, and next to the real system chrome the difference shows. */
const GLYPH = {
  width: 10,
  height: 10,
  viewBox: "0 0 10 10",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1,
  "aria-hidden": true,
} as const;

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const openModal = useUI((s) => s.openModal);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const groups = useProjects((s) => s.groups);
  const updateLayout = useProjects((s) => s.updateLayout);
  const projectOfGroup = useProjects((s) => s.projectOfGroup);
  const changesOpen = useChanges((s) => s.open);
  const toggleChanges = useChanges((s) => s.toggle);
  const benchOpen = useBench((s) => s.open);
  const toggleBench = useBench((s) => s.toggle);
  const notesOpen = useNotes((s) => s.open);
  const toggleNotes = useNotes((s) => s.toggleView);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  // The project on screen plus the global list — the badge counts what is
  // pending *here*, not in a project the user closed hours ago.
  const pendingTasks = useBench((s) =>
    relevantTasks(s.tasks, activeProjectId).reduce((n, t) => n + (t.done ? 0 : 1), 0),
  );
  const changedCount = useChanges((s) =>
    activeProjectId ? (s.gitByProject[activeProjectId]?.files.length ?? 0) : 0,
  );

  const group = groups.find((g) => g.id === activeGroupId);
  const project = activeGroupId ? projectOfGroup(activeGroupId) : undefined;
  const layout = group ? parseLayout(group.layoutJson) : null;
  const floor = layout?.floor;
  const ProjectIcon = projectIcon(project?.icon);

  useEffect(() => {
    const subscription = new AsyncDisposer();
    void appWindow.isMaximized().then((value) => {
      if (!subscription.disposed) setMaximized(value);
    });
    void subscription.add(
      appWindow.onResized(() => {
        void appWindow.isMaximized().then((value) => {
          if (!subscription.disposed) setMaximized(value);
        });
      }),
    );
    return () => subscription.dispose();
  }, []);

  return (
    <header
      className="titlebar"
      data-tauri-drag-region="deep"
      // The bar is almost all drag area; right-clicking it gave nothing back
      // — not even the window menu, which the custom decoration took off
      // stage. Now it is the app's map.
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {menu && (
        <ContextMenu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={titleBarMenu(
            {
              sidebar: sidebarOpen,
              changes: changesOpen,
              bench: benchOpen,
              notes: notesOpen,
              maximized,
            },
            {
              toggleSidebar,
              toggleChanges,
              toggleBench,
              toggleNotes,
              openModal,
              toggleMaximize: () => void appWindow.toggleMaximize(),
              minimize: () => void appWindow.minimize(),
            },
          )}
        />
      )}
      <div className="titlebar-left">
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
        <span className="brand">
          <img
            className="brand-mark"
            src="/yard-app-icon.png"
            alt=""
            aria-hidden="true"
          />
          Yard
        </span>
        {project && (
          <span
            className="crumb"
            data-tip={project.path}
            data-tip-at="left"
          >
            <ProjectIcon
              size={14}
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

      <div className="titlebar-center">
        {activeGroupId && layout && (
          <div className="layout-switch" role="group" aria-label="Layout do grupo">
            <LayoutGrid size={13} aria-hidden="true" />
            {MODES.map((m) => (
              <button
                key={m.id}
                className={layout.mode === m.id ? "is-active" : ""}
                aria-pressed={layout.mode === m.id}
                onClick={() => updateLayout(activeGroupId, { mode: m.id })}
                data-tip={m.tip}
              >
                {m.label}
              </button>
            ))}
            {(layout.mode === "grid" || layout.mode === "spotlight") && (
              <Select
                value={String(layout.panelCount)}
                label="Número de painéis"
                tip="Número de painéis"
                options={PANES}
                onChange={(v) =>
                  updateLayout(activeGroupId, { panelCount: Number(v) })
                }
              />
            )}
          </div>
        )}
      </div>

      <div className="titlebar-right">
        {/* Usage + Energético share one chip: the two "read, rarely clicked"
            controls out of what used to be eight simultaneous targets. */}
        <StatusChip />
        <button
          className="btn btn--ghost"
          data-tip="Nova aba — CLI ou navegador (Ctrl+T)"
          onClick={() => openModal("new-terminal")}
        >
          <Plus size={13} aria-hidden="true" /> Nova aba
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
          className={`icon-btn changes-toggle ${benchOpen ? "is-active" : ""}`}
          data-tip="Bancada — tarefas e prompts (Ctrl+Shift+B)"
          data-tip-at="right"
          aria-label={
            pendingTasks > 0
              ? `Bancada — tarefas e prompts (${pendingTasks} pendentes)`
              : "Bancada — tarefas e prompts"
          }
          aria-pressed={benchOpen}
          onClick={toggleBench}
        >
          <PanelRight size={14} />
          {pendingTasks > 0 && (
            <span className="changes-toggle-badge" aria-hidden="true">
              {pendingTasks > 99 ? "99+" : pendingTasks}
            </span>
          )}
        </button>
        <button
          className={`icon-btn ${notesOpen ? "is-active" : ""}`}
          data-tip="Anotações — caderno markdown (Ctrl+Shift+N)"
          data-tip-at="right"
          aria-label="Anotações"
          aria-pressed={notesOpen}
          onClick={toggleNotes}
        >
          <NotebookPen size={14} />
        </button>
        <button
          className="icon-btn"
          data-tip="Extensões (Ctrl+Shift+X)"
          data-tip-at="right"
          aria-label="Extensões"
          onClick={() => openModal("extensions")}
        >
          <Blocks size={14} />
        </button>
        <button
          className="icon-btn"
          data-tip="Configurações (Ctrl+Shift+P)"
          data-tip-at="right"
          aria-label="Configurações"
          onClick={() => openModal("preferences")}
        >
          <Settings size={14} />
        </button>
      </div>

      {/* Windows window controls: minimize / maximize / close, flush to the
          top-right corner at the system's own metrics. No tooltip here —
          the balloon would open below the screen edge, and everyone already
          knows what these three do. */}
      <div className="win-controls">
        <button
          className="win-btn"
          onClick={() => void appWindow.minimize()}
          aria-label="Minimizar"
        >
          <svg {...GLYPH}>
            <path d="M0.5 5.5h9" />
          </svg>
        </button>
        <button
          className="win-btn"
          onClick={() => void appWindow.toggleMaximize()}
          aria-label={maximized ? "Restaurar" : "Maximizar"}
        >
          {maximized ? (
            <svg {...GLYPH}>
              <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
              <path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
            </svg>
          ) : (
            <svg {...GLYPH}>
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
            </svg>
          )}
        </button>
        <button
          className="win-btn win-btn--close"
          onClick={() => void appWindow.close()}
          aria-label="Fechar"
        >
          <svg {...GLYPH}>
            <path d="M0.7 0.7 9.3 9.3M9.3 0.7 0.7 9.3" />
          </svg>
        </button>
      </div>
    </header>
  );
}
