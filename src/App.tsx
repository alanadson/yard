import { lazy, Suspense, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { FolderPlus, X } from "lucide-react";

import { TitleBar } from "./components/TitleBar";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { WorkspaceGrid } from "./components/WorkspaceGrid";
import { ChangesPanel } from "./components/ChangesPanel";
import { Composer } from "./components/Composer";
import { NewFloorModal } from "./components/Floors";
import { NewTerminalModal } from "./components/modals/NewTerminalModal";
import { NewPortalModal } from "./components/modals/NewPortalModal";
import { NewProjectModal } from "./components/modals/NewProjectModal";
import { PreferencesModal } from "./components/modals/PreferencesModal";
import { ProjectStyleModal } from "./components/modals/ProjectStyleModal";
import { RoutinesModal } from "./components/modals/RoutinesModal";
import { ScoresModal } from "./components/modals/ScoresModal";
import { SessionsModal } from "./components/modals/SessionsModal";
import { ShortcutsModal } from "./components/modals/ShortcutsModal";
import { useGlobalEvents } from "./hooks/useGlobalEvents";
import { useKeybindings } from "./hooks/useKeybindings";
import { useRoutines } from "./hooks/useRoutines";
import { startBridge } from "./lib/bridge";
import { uiLog } from "./lib/log";
import { useChanges } from "./stores/changesStore";
import { useProjects } from "./stores/projectsStore";
import { isLive, useTerminals } from "./stores/terminalsStore";
import { useUI } from "./stores/uiStore";
import "./styles.css";

// Two full-screen overlays that most sessions never open. Both render `null`
// while closed, so they cost nothing at runtime — but their modules (and the
// icon set each pulls in) were sitting in the startup bundle.
const DiffViewer = lazy(() =>
  import("./components/DiffViewer").then((m) => ({ default: m.DiffViewer })),
);
const LiveView = lazy(() =>
  import("./components/LiveView").then((m) => ({ default: m.LiveView })),
);

export default function App() {
  const [booting, setBooting] = useState(true);
  const load = useProjects((s) => s.load);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const changesOpen = useChanges((s) => s.open);
  const loadPrefs = useUI((s) => s.loadPrefs);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const modal = useUI((s) => s.modal);
  const modalPayload = useUI((s) => s.modalPayload);
  const toast = useUI((s) => s.toast);
  const dismissToast = useUI((s) => s.dismissToast);
  const openModal = useUI((s) => s.openModal);

  useGlobalEvents();
  useKeybindings();
  useRoutines();

  // Agent<->app bridge: serves the `yard` CLI invoked from inside PTYs.
  useEffect(() => startBridge(), []);

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([load(), loadPrefs()]);
        const s = useProjects.getState();
        uiLog.info(
          `workspace carregado: rev=${s.rev} projetos=${s.projects.length} ` +
            `grupos=${s.groups.length} terminais=${s.terminals.length} ` +
            `grupoAtivo=${s.activeGroupId ?? "-"}`,
        );
      } catch (e) {
        uiLog.error(`falha ao carregar o workspace: ${e}`);
      } finally {
        setBooting(false);
      }
    })();
  }, [load, loadPrefs]);

  // Working root of the active group: the floor's worktree, when there is one.
  // A primitive (string) on purpose — safe for the Zustand selector.
  const activeRoot = useProjects((s) =>
    s.activeGroupId ? s.rootOfGroup(s.activeGroupId) : null,
  );

  // Watch the active project's files (the watcher keeps accumulating in the
  // background — switching projects does not wipe the previous feed) and
  // tear down watchers for projects removed from the workspace.
  //
  // On a floor, the watcher and `git status` point at the floor's worktree,
  // not the ground — the files panel follows the active group.
  useEffect(() => {
    if (booting) return;
    const active = projects.find((p) => p.id === activeProjectId);
    if (active) {
      void useChanges.getState().ensureWatch(active.id, activeRoot ?? active.path);
    }
    useChanges
      .getState()
      .syncWatches(projects.map(({ id, path }) => ({ id, path })));
  }, [booting, projects, activeProjectId, activeRoot]);

  // Window close is always intercepted: autosave has a 600 ms debounce,
  // and letting close go through would lose the last clicks (a project or CLI
  // just created would vanish on the next boot). Save first, ask if there are
  // live agents (§F3), then destroy. Tauri has no "close and keep
  // running": either we proceed and the trees die cleanly via Job Objects, or
  // we cancel.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await useProjects.getState().save();
        } catch (e) {
          // No disk, nothing we can do; close anyway.
          uiLog.error(`falha ao salvar o workspace no fechamento: ${e}`);
        }

        const { prefs } = useUI.getState();
        const vivos = Object.values(useTerminals.getState().byId).filter(isLive).length;
        if (prefs.confirmOnExit && vivos > 0) {
          const seguir = await ask(
            `${vivos} terminal(is) ainda rodando. Fechar o Yard encerra as árvores de processo.`,
            { title: "Fechar o Yard?", kind: "warning" },
          );
          if (!seguir) return;
        }
        await getCurrentWindow().destroy();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  if (booting) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <div className="boot-mark">Y</div>
          <span>carregando workspace…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <div
        className="app-body"
        data-sidebar={sidebarOpen ? "open" : "closed"}
        data-changes={changesOpen ? "open" : "closed"}
      >
        {sidebarOpen && <ProjectSidebar />}
        <main className="workspace">
          {activeGroupId ? (
            <WorkspaceGrid groupId={activeGroupId} />
          ) : (
            <div className="grid-empty">
              <div className="welcome">
                <div className="welcome-mark" aria-hidden="true">
                  Y
                </div>
                <h2>
                  {projects.length === 0
                    ? "Comece pela pasta de um projeto"
                    : "Escolha um grupo para começar"}
                </h2>
                <p>
                  {projects.length === 0
                    ? "O Yard roda as CLIs de agentes dentro dessa pasta e acompanha o que elas mexem no disco."
                    : "Cada grupo é um conjunto de CLIs sobre o mesmo projeto. Selecione um na barra lateral."}
                </p>
                {projects.length === 0 && (
                  <button
                    className="btn btn--primary"
                    onClick={() => openModal("new-project")}
                  >
                    <FolderPlus size={13} /> Adicionar projeto
                  </button>
                )}
                <div className="welcome-hints">
                  <span className="welcome-hint">
                    <kbd>Ctrl</kbd> + <kbd>T</kbd> abre um terminal
                  </span>
                  <span className="welcome-hint">
                    <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>H</kbd> lista os
                    atalhos
                  </span>
                </div>
              </div>
            </div>
          )}
        </main>
        {changesOpen && <ChangesPanel />}
      </div>

      <Suspense fallback={null}>
        <LiveView />
        <DiffViewer />
      </Suspense>
      <Composer />

      {modal === "new-terminal" && <NewTerminalModal />}
      {modal === "new-portal" && <NewPortalModal />}
      {modal === "new-project" && <NewProjectModal />}
      {modal === "new-floor" && <NewFloorModal />}
      {modal === "project-style" && (
        <ProjectStyleModal
          projectId={
            (modalPayload as { projectId?: string } | null)?.projectId ?? ""
          }
        />
      )}
      {modal === "preferences" && <PreferencesModal />}
      {modal === "shortcuts" && <ShortcutsModal />}
      {modal === "routines" && <RoutinesModal />}
      {modal === "scores" && <ScoresModal />}
      {modal === "sessions" && (
        <SessionsModal
          projectPath={
            (modalPayload as { projectPath?: string } | null)?.projectPath ?? ""
          }
        />
      )}

      {toast && (
        <div
          className={`toast toast--${toast.kind}`}
          role="status"
          aria-live={toast.kind === "error" ? "assertive" : "polite"}
        >
          <span>{toast.message}</span>
          <button
            className="icon-btn"
            aria-label="Dispensar aviso"
            onClick={dismissToast}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
