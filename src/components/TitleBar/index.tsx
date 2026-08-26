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
  FileDiff,
  Frame,
  GitBranch,
  LayoutGrid,
  NotebookPen,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
} from "lucide-react";

// i18n-scan: tables
import { useNow } from "../../hooks/useNow";
import { useT } from "../../hooks/useT";
import { tn } from "../../lib/i18n";
import { show } from "../../lib/navigate";
import { projectIcon } from "../../lib/projectStyle";
import { AsyncDisposer } from "../../lib/disposables";
import { Select } from "../Select";
import { StatusChip } from "./StatusChip";
import { dockToggle, dueTasks } from "./dockToggle";
import { useBench } from "../../stores/benchStore";
import { useChanges } from "../../stores/changesStore";
import { useNotes } from "../../stores/notesStore";
import { ContextMenu, type MenuAnchor } from "../ContextMenu";
import { titleBarMenu } from "../../lib/titleBarMenu";
import { parseLayout, useProjects, type LayoutMode } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { layoutControlsState } from "./layoutControls";

const appWindow = getCurrentWindow();

/**
 * The shapes of the pane grid. Canvas is deliberately **not** here: it is the
 * group's other surface, with its own CLIs, and it gets its own button — as a
 * fourth segment it shared this field and wiped the Grade/Holofote the user
 * had pinned every time they looked at the board.
 */
const MODES: { id: LayoutMode; label: string; tip: string }[] = [
  { id: "auto", label: "Auto", tip: "Automático: a grade segue os painéis usados" },
  { id: "grid", label: "Grade", tip: "Grade fixa, com o número de painéis ao lado" },
  { id: "spotlight", label: "Holofote", tip: "Um painel grande, os outros ao lado" },
];

const PANES = [1, 2, 3, 4, 6].map((n) => ({ value: String(n), n }));

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
  const t = useT();
  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const openModal = useUI((s) => s.openModal);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const groupBeforeBoard = useProjects((s) => s.groupBeforeBoard);
  const groups = useProjects((s) => s.groups);
  const updateLayout = useProjects((s) => s.updateLayout);
  const projectOfGroup = useProjects((s) => s.projectOfGroup);
  const changesOpen = useChanges((s) => s.open);
  const toggleChanges = useChanges((s) => s.toggle);
  const benchOpen = useBench((s) => s.open);
  const toggleBench = useBench((s) => s.toggle);
  const notesOpen = useNotes((s) => s.open);
  const toggleNotes = useNotes((s) => s.toggleView);
  const statusBarOpen = useUI((s) => s.prefs.statusBar);
  const setPref = useUI((s) => s.setPref);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  // A minute clock: the dot cares about "today", and a task due today turns
  // overdue at midnight with nobody touching the list.
  const now = useNow(60_000);
  // The project on screen plus the global list — what is due *here*, not in
  // a project the user closed hours ago.
  const due = useBench((s) => dueTasks(s.tasks, activeProjectId, now));
  const changedCount = useChanges((s) =>
    activeProjectId ? (s.gitByProject[activeProjectId]?.files.length ?? 0) : 0,
  );
  // Doors, not gauges: what each panel toggle says and whether it wears the
  // attention dot (`dockToggle.ts`, tested).
  const sidebarDoor = dockToggle("sidebar", { open: sidebarOpen });
  const changesDoor = dockToggle("changes", { open: changesOpen, changed: changedCount });
  const benchDoor = dockToggle("bench", { open: benchOpen, due });
  const notesDoor = dockToggle("notes", { open: notesOpen });

  const group = groups.find((g) => g.id === activeGroupId);
  const project = activeGroupId ? projectOfGroup(activeGroupId) : undefined;
  const activeLayout = group ? parseLayout(group.layoutJson) : null;
  // A board belongs to no project: it is the canvas as its own container. The
  // switch still describes the screen, while its pane modes belong to the
  // project group remembered by `layoutControlsState`.
  const board = group && group.projectId === null ? group : null;
  const leaveBoard = useProjects((s) => s.leaveBoard);
  const controls = layoutControlsState({
    activeGroupId,
    activeProjectId,
    groupBeforeBoard,
    activeSurface: activeLayout?.surface ?? "grid",
    groups,
  });
  const controlGroup = groups.find((candidate) => candidate.id === controls?.groupId);
  const layout = controlGroup ? parseLayout(controlGroup.layoutJson) : null;
  const onBoard = controls?.canvasActive ?? false;
  const floor = activeLayout?.floor;
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
              statusBar: statusBarOpen,
              maximized,
            },
            {
              toggleSidebar,
              toggleChanges,
              toggleBench,
              toggleNotes,
              toggleStatusBar: () => setPref("statusBar", !statusBarOpen),
              openModal,
              toggleMaximize: () => void appWindow.toggleMaximize(),
              minimize: () => void appWindow.minimize(),
            },
          )}
        />
      )}
      <div className="titlebar-left">
        <button
          className="icon-btn dock-toggle"
          data-tip={sidebarDoor.tip}
          data-tip-at="left"
          aria-label={sidebarDoor.label}
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
        {board ? (
          <span className="crumb" data-tip={t("Quadro — o canvas como container próprio")}>
            <Frame size={14} className="crumb-icon" aria-hidden="true" />
            <span className="crumb-project">{board.name}</span>
          </span>
        ) : (
          project && (
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
                    data-tip={t("Frente isolada — worktree em {path}", { path: floor.worktreePath ?? "?" })}
                  >
                    <GitBranch size={10} aria-hidden="true" />
                    {floor.branch}
                  </span>
                )}
              </>
            )}
          </span>
          )
        )}
      </div>

      <div className="titlebar-center">
        {controls && layout && (
          <>
            <div
              className={`layout-switch ${onBoard ? "is-behind" : ""}`}
              role="group"
              aria-label={t("Layout dos painéis")}
            >
              <LayoutGrid size={13} aria-hidden="true" />
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={!onBoard && layout.mode === m.id ? "is-active" : ""}
                  aria-pressed={!onBoard && layout.mode === m.id}
                  // Picking a shape while the board is up also brings the panes
                  // back: otherwise the click changes something the user cannot
                  // see, which reads as a dead button.
                  onClick={() => {
                    updateLayout(controls.groupId, { mode: m.id });
                    show(controls.groupId, "grid");
                    if (board) leaveBoard();
                  }}
                  data-tip={t(m.tip)}
                >
                  {t(m.label)}
                </button>
              ))}
              {(layout.mode === "grid" || layout.mode === "spotlight") && (
                <Select
                  value={String(layout.panelCount)}
                  label={t("Número de painéis")}
                  tip={t("Número de painéis")}
                  options={PANES.map((p) => ({
                    value: p.value,
                    label: tn(p.n, "{n} painel", "{n} painéis"),
                  }))}
                  onChange={(v) =>
                    updateLayout(controls.groupId, { panelCount: Number(v) })
                  }
                />
              )}
            </div>
            <button
              className={`layout-canvas ${onBoard ? "is-active" : ""}`}
              aria-pressed={onBoard}
              data-tip={t("Canvas infinito: cartões soltos, desenho à mão, notas e conexões — com as CLIs dele")}
              onClick={() => {
                show(controls.groupId, onBoard ? "grid" : "canvas");
                if (board && onBoard) leaveBoard();
              }}
            >
              <Frame size={13} aria-hidden="true" /> Canvas
            </button>
          </>
        )}
      </div>

      <div className="titlebar-right">
        {/* Usage + Energético share one chip: the two "read, rarely clicked"
            controls out of what used to be eight simultaneous targets. */}
        <StatusChip />
        <button
          className="btn btn--ghost"
          data-tip={t("Nova aba — CLI ou navegador (Ctrl+T)")}
          onClick={() => openModal("new-terminal")}
        >
          <Plus size={13} aria-hidden="true" /> {t("Nova aba")}
        </button>
        {/* The three doors, in the order their panels sit on screen: changes
            slots in between the workspace and the bench, the bench is the
            outermost right drawer (its glyph pairs with the sidebar's), the
            notebook floats. Open = the sidebar's blue pill; the count of
            changed files lives in the balloon and in the status bar, never
            as a pill here — see `dockToggle.ts`. */}
        <button
          className="icon-btn dock-toggle"
          data-tip={changesDoor.tip}
          data-tip-at="right"
          aria-label={changesDoor.label}
          aria-pressed={changesOpen}
          onClick={toggleChanges}
        >
          <FileDiff size={14} />
        </button>
        <button
          className="icon-btn dock-toggle"
          data-tip={benchDoor.tip}
          data-tip-at="right"
          aria-label={benchDoor.label}
          aria-pressed={benchOpen}
          onClick={toggleBench}
        >
          <PanelRight size={14} />
          {benchDoor.dot && <span className="dock-toggle-dot" aria-hidden="true" />}
        </button>
        <button
          className="icon-btn dock-toggle"
          data-tip={notesDoor.tip}
          data-tip-at="right"
          aria-label={notesDoor.label}
          aria-pressed={notesOpen}
          onClick={toggleNotes}
        >
          <NotebookPen size={14} />
        </button>
        {/* What opens a panel, then what opens a window: five identical
            squares in a row give the eye no seam, so the two families get a
            hairline between them. */}
        <span className="titlebar-sep" aria-hidden="true" />
        <button
          className="icon-btn"
          data-tip={t("Extensões (Ctrl+Shift+X)")}
          data-tip-at="right"
          aria-label={t("Extensões")}
          onClick={() => openModal("extensions")}
        >
          <Blocks size={14} />
        </button>
        <button
          className="icon-btn"
          data-tip={t("Configurações (Ctrl+Shift+P)")}
          data-tip-at="right"
          aria-label={t("Configurações")}
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
          aria-label={t("Minimizar")}
        >
          <svg {...GLYPH}>
            <path d="M0.5 5.5h9" />
          </svg>
        </button>
        <button
          className="win-btn"
          onClick={() => void appWindow.toggleMaximize()}
          aria-label={maximized ? t("Restaurar") : t("Maximizar")}
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
          aria-label={t("Fechar")}
        >
          <svg {...GLYPH}>
            <path d="M0.7 0.7 9.3 9.3M9.3 0.7 0.7 9.3" />
          </svg>
        </button>
      </div>
    </header>
  );
}
