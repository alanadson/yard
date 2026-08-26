import { lazy, useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Download, FolderOpen, FolderPlus, Loader2, RefreshCw, X } from "lucide-react";

import { ContextMenu, type MenuAnchor } from "./components/ContextMenu";
import { GlobalMenu } from "./components/ContextMenu/GlobalMenu";
import { TitleBar } from "./components/TitleBar";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Overlay } from "./components/Overlay";
import { WorkspaceGrid } from "./components/WorkspaceGrid";
import { useGlobalEvents } from "./hooks/useGlobalEvents";
import { useOccluder } from "./hooks/useOccluder";
import { useKeybindings } from "./hooks/useKeybindings";
import { useLspLifecycle } from "./hooks/useLspLifecycle";
import { useRoutines } from "./hooks/useRoutines";
import { useTheme } from "./hooks/useTheme";
import { useLanguage } from "./hooks/useLanguage";
import { useFirstRun } from "./hooks/useFirstRun";
import { useTray } from "./hooks/useTray";
import { useUpdaterChecks } from "./hooks/useUpdater";
import { useT } from "./hooks/useT";
import { tn } from "./lib/i18n";
import { useTriggers } from "./hooks/useTriggers";
import { useAutoBackupTimer } from "./hooks/useAutoBackupTimer";
import { useAutoBackup } from "./stores/autoBackupStore";
import { cancelBackupRestore, restartIntoBackup } from "./lib/backupFlow";
import { startBridge } from "./lib/bridgeListener";
import { loadBundledFonts } from "./lib/bundledFonts";
import { AsyncDisposer } from "./lib/disposables";
import { applyFontPrefs } from "./lib/fonts";
import { ipc } from "./lib/ipc";
import { reconcileAliveFlags } from "./lib/lifecycle";
import { uiLog } from "./lib/log";
import { readInitialPrefs } from "./lib/prefs";
import { setQuitHandler } from "./lib/quit";
import { startPtyWatch } from "./lib/ptyWatch";
import { baseName } from "./lib/terminals";
import { useAgentDefaults } from "./stores/agentDefaultsStore";
import { useAgents } from "./stores/agentsStore";
import { useBench } from "./stores/benchStore";
import { useBrowsers, watchPaneBrowserEvents } from "./stores/browsersStore";
import { useChanges } from "./stores/changesStore";
import { isDirty, isReadOnly, useEditor } from "./stores/editorStore";
import { useExtensions } from "./stores/extensionsStore";
import { INTERRUPTED, useFlows } from "./stores/flowStore";
import { useLive } from "./stores/liveStore";
import { useNotes } from "./stores/notesStore";
import { startKeepAwake, usePower } from "./stores/powerStore";
import { useOnboarding } from "./stores/onboardingStore";
import { useUpdater } from "./stores/updaterStore";
import { installUpdate } from "./lib/updateFlow";
import { useProjects } from "./stores/projectsStore";
import { useReview } from "./stores/reviewStore";
import { isLive, useTerminals } from "./stores/terminalsStore";
import {
  BENCH_MIN,
  CHANGES_MIN,
  SIDEBAR_MIN,
  useUI,
  type Toast,
} from "./stores/uiStore";
import "./styles.css";
// The light appearance: the same tokens, other values, keyed on
// `<html data-theme="light">` — loaded on boot so the shell never opens dark
// and flips (`src/theme-light.test.ts` locks the order).
import "./theme-light.css";

/** Floor of the terminal canvas — mirrors `.workspace`'s `min-width`. */
const WORKSPACE_MIN = 320;

// Two full-screen overlays that most sessions never open. Both render `null`
// while closed, so they cost nothing at runtime — but their modules (and the
// icon set each pulls in) were sitting in the startup bundle.
const DiffViewer = lazy(() =>
  import("./components/DiffViewer").then((m) => ({ default: m.DiffViewer })),
);
const LiveView = lazy(() =>
  import("./components/LiveView").then((m) => ({ default: m.LiveView })),
);
// The editor drags CodeMirror and the grammars along — it is only downloaded
// when someone actually opens a file.
const CodeEditor = lazy(() =>
  import("./components/CodeEditor").then((m) => ({ default: m.CodeEditor })),
);
const BenchPanel = lazy(() =>
  import("./components/BenchPanel").then((m) => ({ default: m.BenchPanel })),
);
// The notebook rides the same wagon as the editor: CodeMirror only downloads
// when someone opens notes (or a file).
const NotesView = lazy(() =>
  import("./components/NotesView").then((m) => ({ default: m.NotesView })),
);
// Same module, other place: the notebook occupying the central area.
const NotesCenter = lazy(() =>
  import("./components/NotesView").then((m) => ({ default: m.NotesCenter })),
);
const ChangesPanel = lazy(() =>
  import("./components/ChangesPanel").then((m) => ({ default: m.ChangesPanel })),
);
const Composer = lazy(() =>
  import("./components/Composer").then((m) => ({ default: m.Composer })),
);
const Palette = lazy(() =>
  import("./components/Palette").then((m) => ({ default: m.Palette })),
);
const NewTerminalModal = lazy(() =>
  import("./components/modals/NewTerminalModal").then((m) => ({ default: m.NewTerminalModal })),
);
const NewPortalModal = lazy(() =>
  import("./components/modals/NewPortalModal").then((m) => ({ default: m.NewPortalModal })),
);
const NewProjectModal = lazy(() =>
  import("./components/modals/NewProjectModal").then((m) => ({ default: m.NewProjectModal })),
);
const NewFloorModal = lazy(() =>
  import("./components/Floors/NewFloorModal").then((m) => ({ default: m.NewFloorModal })),
);
const FanoutModal = lazy(() =>
  import("./components/Floors/FanoutModal").then((m) => ({ default: m.FanoutModal })),
);
const LandModal = lazy(() =>
  import("./components/Floors/LandModal").then((m) => ({ default: m.LandModal })),
);
const CloseFloorModal = lazy(() =>
  import("./components/Floors/CloseFloorModal").then((m) => ({ default: m.CloseFloorModal })),
);
const CompareModal = lazy(() =>
  import("./components/Floors/CompareModal").then((m) => ({ default: m.CompareModal })),
);
const SettingsScreen = lazy(() =>
  import("./components/Settings").then((m) => ({ default: m.SettingsScreen })),
);
const ExtensionsModal = lazy(() =>
  import("./components/modals/ExtensionsModal").then((m) => ({ default: m.ExtensionsModal })),
);
const ProjectStyleModal = lazy(() =>
  import("./components/modals/ProjectStyleModal").then((m) => ({ default: m.ProjectStyleModal })),
);
const RoleModal = lazy(() =>
  import("./components/modals/RoleModal").then((m) => ({ default: m.RoleModal })),
);
const RoutinesModal = lazy(() =>
  import("./components/modals/RoutinesModal").then((m) => ({ default: m.RoutinesModal })),
);
const FlowModal = lazy(() =>
  import("./components/modals/FlowModal").then((m) => ({ default: m.FlowModal })),
);
const ScmConfirmModal = lazy(() =>
  import("./components/modals/ScmConfirmModal").then((m) => ({
    default: m.ScmConfirmModal,
  })),
);
const ScoresModal = lazy(() =>
  import("./components/modals/ScoresModal").then((m) => ({ default: m.ScoresModal })),
);
const SessionsModal = lazy(() =>
  import("./components/modals/SessionsModal").then((m) => ({ default: m.SessionsModal })),
);
const ShortcutsModal = lazy(() =>
  import("./components/modals/ShortcutsModal").then((m) => ({ default: m.ShortcutsModal })),
);
const OnboardingModal = lazy(() =>
  import("./components/modals/OnboardingModal").then((m) => ({ default: m.OnboardingModal })),
);
const CostsModal = lazy(() =>
  import("./components/modals/CostsModal").then((m) => ({ default: m.CostsModal })),
);
const ShoulderModal = lazy(() =>
  import("./components/modals/ShoulderModal").then((m) => ({ default: m.ShoulderModal })),
);
const TranscriptModal = lazy(() =>
  import("./components/modals/TranscriptModal").then((m) => ({ default: m.TranscriptModal })),
);

export default function App() {
  const [booting, setBooting] = useState(true);
  const [retrying, setRetrying] = useState(false);
  /** Panels the window itself closed — the ones it owes back when it widens. */
  const closedByLayout = useRef({
    bench: false,
    changes: false,
    sidebar: false,
  });
  const load = useProjects((s) => s.load);
  const loadError = useProjects((s) => s.loadError);
  const saveError = useProjects((s) => s.saveError);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const changesOpen = useChanges((s) => s.open);
  const viewerOpen = useChanges((s) => s.viewer !== null);
  const benchOpen = useBench((s) => s.open);
  const editorOpen = useEditor((s) => s.open);
  const notesOpen = useNotes((s) => s.open);
  // Where the notebook lives decides which face `notesOpen` shows: the
  // overlay sheet, or the central area in the workspace's place.
  const notesCenter = useNotes((s) => s.place.kind === "center");
  const liveOpen = useLive((s) => s.phase !== "closed");
  const loadPrefs = useUI((s) => s.loadPrefs);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const modal = useUI((s) => s.modal);
  const modalPayload = useUI((s) => s.modalPayload);
  const toasts = useUI((s) => s.toasts);
  const toastOverflow = useUI((s) => s.toastOverflow);
  const backupPending = useUI((s) => s.backupPending);
  const updateOffer = useUpdater((s) => (s.phase === "available" ? s.version : null));
  const dismissToast = useUI((s) => s.dismissToast);
  const openModal = useUI((s) => s.openModal);
  const [welcomeMenu, setWelcomeMenu] = useState<MenuAnchor | null>(null);
  const composerOpen = useUI((s) => s.composerOpen);
  const paletteOpen = useUI((s) => s.paletteOpen);

  useGlobalEvents();
  useKeybindings();
  useRoutines();
  useTheme();
  useLanguage();
  const t = useT();
  useTray();
  useFirstRun();
  useUpdaterChecks();
  useAutoBackupTimer();
  useTriggers();
  useLspLifecycle();

  // Chosen fonts → CSS variables on <html>. One scalar per subscription, like
  // the terminals do: `s.prefs` is rebuilt on every splitter drag.
  const uiFontFamily = useUI((s) => s.prefs.uiFontFamily);
  const codeFontFamily = useUI((s) => s.prefs.codeFontFamily);
  const codeLigatures = useUI((s) => s.prefs.codeLigatures);
  useEffect(() => {
    applyFontPrefs({ uiFontFamily, codeFontFamily, codeLigatures });
  }, [uiFontFamily, codeFontFamily, codeLigatures]);

  // The bundled code fonts arrive with their extension. Loaded on boot too
  // (not only on toggle): a terminal measured before the @font-face exists
  // falls back to Consolas until its next relayout.
  const codeFonts = useExtensions((s) => s.enabled["code-fonts"] === true);
  useEffect(() => {
    if (!codeFonts) return;
    void loadBundledFonts().catch((e) =>
      uiLog.warn(`falha ao carregar fontes embutidas: ${e}`),
    );
  }, [codeFonts]);

  // Agent<->app bridge: serves the `yard` CLI invoked from inside PTYs.
  useEffect(() => startBridge(), []);

  // The agent catalogue (who resumes a conversation, who records a session).
  // Read once, off the boot's critical path: the screens that depend on it
  // treat "don't know yet" as "does not offer the extra".
  useEffect(() => {
    void useAgents.getState().load();
  }, []);

  // Navigation and popups of the pane browser tabs — heard app-wide, because
  // a page can redirect while its pane is not even mounted.
  useEffect(() => watchPaneBrowserEvents(), []);

  // Exit and activity of **every** terminal, not only the ones with a pane
  // mounted — what keeps "is this CLI busy?" and "is it still alive?" honest
  // for the groups nobody is looking at (see `lib/ptyWatch.ts`).
  useEffect(() => startPtyWatch(), []);

  // Energy mode (keep-awake): reconciles "should the PC stay awake?" with the
  // backend.
  useEffect(() => startKeepAwake(), []);

  // Esc dismisses an open tooltip balloon (WCAG 1.4.13). Capture phase and no
  // preventDefault: the same Esc keeps closing whatever layer owns it — this
  // only hides balloons until the focus or the pointer moves on.
  useEffect(() => {
    const release = () => {
      document.body.classList.remove("tips-off");
      window.removeEventListener("focusin", release, true);
      window.removeEventListener("pointermove", release, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      document.body.classList.add("tips-off");
      window.addEventListener("focusin", release, true);
      window.addEventListener("pointermove", release, true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      release();
    };
  }, []);

  // A staged backup import survives a reload of the webview: ask the backend,
  // not the session, so the warning bar comes back after F5 too.
  useEffect(() => {
    void ipc
      .backupPending()
      .then((pending) => useUI.getState().setBackupPending(pending))
      .catch(() => {});
  }, []);

  const boot = useCallback(async () => {
    try {
      // One SQLite/IPC read hydrates every preference-backed store. Starting
      // it before the workspace load keeps both independent branches parallel.
      const bootPrefs = readInitialPrefs().catch((error) => {
        uiLog.warn(`não consegui ler as preferências do boot: ${error}`);
        return {};
      });
      await Promise.all([
        load(),
        bootPrefs.then((prefs) => loadPrefs(prefs)),
        bootPrefs.then((prefs) => useBench.getState().load(prefs)),
        // Before anything can be spawned: the fixed command line of each CLI
        // is read at spawn time, with no `await` to spare.
        bootPrefs.then((prefs) => useAgentDefaults.getState().load(prefs)),
        bootPrefs.then((prefs) => useBrowsers.getState().load(prefs)),
        bootPrefs.then((prefs) => useReview.getState().load(prefs)),
        bootPrefs.then((prefs) => useExtensions.getState().load(prefs)),
        bootPrefs.then((prefs) => useNotes.getState().load(prefs)),
        bootPrefs.then((prefs) => usePower.getState().load(prefs)),
        // Pipelines that were running when the interface went away. They come
        // back marked as interrupted — the PTY survived the reload, the engine
        // did not, and vanishing silently was the worst possible outcome.
        bootPrefs.then((prefs) => useFlows.getState().restore(prefs)),
        // Tabs and unsaved drafts from before the last reload. F5, an HMR
        // round and a webview reload never reached `onCloseRequested`, so
        // this is the only thing standing between a refresh and lost typing.
        bootPrefs.then((prefs) => useEditor.getState().restore(prefs)),
        // The welcome sheet needs the kv key before it can decide; the
        // decision itself waits for the workspace (`useFirstRun`).
        bootPrefs.then((prefs) => useOnboarding.getState().load(prefs)),
        // The last check's stamp and the ignored version: without them a
        // reload would fetch the manifest again and re-offer what was declined.
        bootPrefs.then((prefs) => useUpdater.getState().load(prefs)),
        // The stamp of the last automatic copy: without it every boot would
        // think no backup was ever made and write one a minute later.
        bootPrefs.then((prefs) => useAutoBackup.getState().load(prefs)),
      ]);
      // Only now are there rows to check against the backend.
      await reconcileAliveFlags().catch((e) =>
        uiLog.warn(`falha ao reconciliar terminais vivos: ${e}`),
      );
      // With the groups finally known, browser tabs whose group left the
      // workspace while the app was down can be told apart from real ones.
      useBrowsers.getState().prune();
      // Same reading for the notebook's dock: a tab in a group that no
      // longer exists falls back to the overlay.
      useNotes.getState().prune();
      // And the composer drafts: a prompt kept for a CLI that no longer
      // exists has nowhere to go.
      useUI
        .getState()
        .pruneComposerDrafts(
          new Set(useProjects.getState().terminals.map((t) => t.id)),
        );
      // An interrupted pipeline has to be said, not only drawn: its HUD may be
      // in a group that is not even on screen.
      const interruptedRuns = Object.values(useFlows.getState().runs).filter(
        (r) => r.error === INTERRUPTED,
      );
      if (interruptedRuns.length) {
        useUI
          .getState()
          .showToast(
            t(
              "{n} fluxo(s) pararam quando a interface recarregou ({names}). As CLIs continuam com o que já receberam.",
              {
                n: interruptedRuns.length,
                names: interruptedRuns.map((r) => `"${r.name}"`).join(", "),
              },
            ),
            "error",
          );
      }
      const s = useProjects.getState();
      uiLog.info(
        `workspace carregado: rev=${s.rev} projetos=${s.projects.length} ` +
          `grupos=${s.groups.length} terminais=${s.terminals.length} ` +
          `grupoAtivo=${s.activeGroupId ?? "-"}`,
      );
    } catch (e) {
      // `loadError` in the store is what the screen reads; this is the trail.
      uiLog.error(`falha ao carregar o workspace: ${e}`);
    } finally {
      setBooting(false);
    }
  }, [load, loadPrefs]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const retryBoot = async () => {
    setRetrying(true);
    try {
      await boot();
    } finally {
      setRetrying(false);
    }
  };

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
    // The file tree lives at the same root. It sits here, not inside the
    // panel: opening a file from the diff or from the feed has to work even
    // if the "Files" tab was never opened in this session.
    useEditor
      .getState()
      .setRoot(active?.id ?? null, active ? (activeRoot ?? active.path) : null);
  }, [booting, projects, activeProjectId, activeRoot]);

  // In a narrow window the three panels together (698 px minimum) plus the
  // canvas floor do not fit — the window can get down to 900 px. The CSS
  // already makes the panels give way down to their own minimum; below that
  // someone has to go, and the order is the inverse of priority: bench,
  // changes, sidebar.
  //
  // What the window takes, the window gives back: closing was one-way, so
  // widening the window again left the panels shut. And the bench closed
  // through `toggle`, which persists — so a resize quietly rewrote a
  // preference the user never touched.
  useEffect(() => {
    const adjust = () => {
      const width = window.innerWidth;
      const leftover = () =>
        width -
        (useUI.getState().sidebarOpen ? SIDEBAR_MIN : 0) -
        (useChanges.getState().open ? CHANGES_MIN : 0) -
        (useBench.getState().open ? BENCH_MIN : 0);

      const closeIt = (
        theKey: keyof typeof closedByLayout.current,
        isOpen: () => boolean,
        action: () => void,
      ) => {
        if (leftover() >= WORKSPACE_MIN || !isOpen()) return;
        closedByLayout.current[theKey] = true;
        action();
      };

      const reopen = (
        key: keyof typeof closedByLayout.current,
        cost: number,
        opened: () => boolean,
        action: () => void,
      ) => {
        if (!closedByLayout.current[key]) return;
        // Already back (the user reopened it): the debt is settled.
        if (opened()) {
          closedByLayout.current[key] = false;
          return;
        }
        if (leftover() - cost < WORKSPACE_MIN) return;
        closedByLayout.current[key] = false;
        action();
      };

      closeIt("bench", () => useBench.getState().open, () =>
        useBench.getState().setOpenForLayout(false),
      );
      closeIt("changes", () => useChanges.getState().open, () =>
        useChanges.getState().toggle(),
      );
      closeIt("sidebar", () => useUI.getState().sidebarOpen, () =>
        useUI.getState().toggleSidebar(),
      );

      // Restored in the inverse order they were taken, so the most important
      // panel is the first one back.
      reopen("sidebar", SIDEBAR_MIN, () => useUI.getState().sidebarOpen, () =>
        useUI.getState().toggleSidebar(),
      );
      reopen("changes", CHANGES_MIN, () => useChanges.getState().open, () =>
        useChanges.getState().toggle(),
      );
      reopen("bench", BENCH_MIN, () => useBench.getState().open, () =>
        useBench.getState().setOpenForLayout(true),
      );
    };
    adjust();
    window.addEventListener("resize", adjust);
    return () => window.removeEventListener("resize", adjust);
    // Re-evaluates also when a panel is opened by shortcut in a tight window.
  }, [sidebarOpen, changesOpen, benchOpen]);

  // Window close is always intercepted: autosave has a 600 ms debounce,
  // and letting close go through would lose the last clicks (a project or CLI
  // just created would vanish on the next boot). Save first, ask if there are
  // live agents (§F3), then destroy. Tauri has no "close and keep
  // running": either we proceed and the trees die cleanly via Job Objects, or
  // we cancel.
  useEffect(() => {
    const subscription = new AsyncDisposer();
    // The flow itself, shared with "Sair" in the tray menu and the palette
    // (`lib/quit.ts`): `force` skips the close-to-tray branch, because those
    // two mean quit.
    const closeFlow = async (force: boolean) => {
      // Close to the tray: the X hides the window and the CLIs go on. The
      // way back is the tray icon or the summon hotkey; quitting is "Sair"
      // in the tray menu or in the palette, which come here with `force`.
      if (!force && useUI.getState().prefs.closeToTray) {
        await getCurrentWindow().hide();
        return;
      }
      // Notes on a debounce timer would miss the train: write them now.
      useNotes.getState().flush();
      try {
        await useProjects.getState().save();
      } catch (e) {
        // No disk, nothing we can do; close anyway.
        uiLog.error(`falha ao salvar o workspace no fechamento: ${e}`);
      }

      // Drafts do survive the close now — `editorStore` writes them to kv and
      // `restore()` brings them back with the conflict banner. So this is no
      // longer "your typing is about to be destroyed"; it is "these files are
      // still only drafts". Saying the old sentence taught the user to
      // distrust the warning the day they discovered it was false.
      const unsaved = useEditor
        .getState()
        .docs.filter((d) => isDirty(d) && !isReadOnly(d));
      if (unsaved.length > 0) {
        const names = unsaved.map((d) => d.path).join(", ");
        const proceed = await ask(
          t(
            "{n} arquivo(s) ainda não gravados no disco: {names}.\n\nOs rascunhos voltam quando você reabrir o Yard, mas o arquivo em disco continua como está — e quem estiver lendo esses arquivos agora (um agente, o build) vê a versão antiga.",
            { n: unsaved.length, names },
          ),
          { title: t("Fechar com arquivos por gravar?"), kind: "warning" },
        );
        if (!proceed) return;
      }

      const { prefs } = useUI.getState();
      const aliveCount = Object.values(useTerminals.getState().byId).filter(isLive).length;
      if (prefs.confirmOnExit && aliveCount > 0) {
        const proceed = await ask(
          t("{n} terminal(is) ainda rodando. Fechar o Yard encerra as árvores de processo.", {
            n: aliveCount,
          }),
          { title: t("Fechar o Yard?"), kind: "warning" },
        );
        if (!proceed) return;
      }
      await getCurrentWindow().destroy();
    };
    setQuitHandler(() => void closeFlow(true));
    void subscription.add(
      getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        await closeFlow(false);
      }),
    );
    return () => {
      setQuitHandler(null);
      subscription.dispose();
    };
  }, []);

  if (booting) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <img className="boot-mark" src="/yard-app-icon.png" alt="" />
          <span>{t("carregando workspace…")}</span>
        </div>
      </div>
    );
  }

  // The workspace never arrived. Falling through to the welcome screen would
  // be a lie — it is the screen of a fresh install, and every project, group
  // and canvas created from here would be dropped by a `save` that refuses to
  // run while `loaded` is false. So the app stops here and says why.
  //
  // Only when there is genuinely nothing in memory. `load` also runs mid-session
  // to recover from a snapshot the backend refused, and a failure *there* leaves
  // the workspace on screen intact — taking it over with a full-screen wall
  // would be a bigger loss than the problem. The `save-warn` bar covers that case.
  if (loadError && projects.length === 0) {
    return (
      <div className="app">
        <TitleBar />
        <div className="boot boot--failed">
          <div className="boot-fail" role="alert">
            <AlertTriangle size={26} className="boot-fail-icon" aria-hidden="true" />
            <h2>{t("Não consegui abrir o workspace")}</h2>
            <p>
              {t("O banco em")} <code>%APPDATA%\Yard\app.db</code>{" "}
              {t("não pôde ser lido, então o Yard está sem os seus projetos — e")}{" "}
              <strong>{t("nada que você fizer agora seria salvo")}</strong>.{" "}
              {t("Por isso a tela parou aqui em vez de abrir vazia.")}
            </p>
            <pre className="boot-fail-detail">{loadError}</pre>
            <p className="boot-fail-hint">
              {t("Causa comum: outra instância do Yard já está aberta com o mesmo diretório de dados. Feche-a e tente de novo.")}
            </p>
            <div className="boot-fail-actions">
              <button
                className="btn btn--primary"
                disabled={retrying}
                onClick={() => void retryBoot()}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {retrying ? t("Tentando…") : t("Tentar de novo")}
              </button>
              <button
                className="btn"
                onClick={() => {
                  void ipc
                    .appPaths()
                    .then((p) => ipc.revealPath(p.appDir))
                    .catch((e) => uiLog.warn(`não consegui abrir a pasta de dados: ${e}`));
                }}
              >
                <FolderOpen size={13} aria-hidden="true" /> {t("Abrir a pasta de dados")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <h1 className="sr-only">Yard</h1>
      <TitleBar />
      {saveError && (
        <div className="save-warn" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>
            {t("Não estou conseguindo gravar o workspace no disco — as últimas mudanças ainda não foram salvas. Tentando de novo automaticamente.")}
          </span>
          <button className="btn btn--sm" onClick={() => void useProjects.getState().save()}>
            {t("Tentar agora")}
          </button>
        </div>
      )}
      {backupPending && (
        // The paragraph inside Preferences was the only warning; closing that
        // modal left the app looking normal while every action landed in the
        // database about to be discarded. This bar stays until the restore is
        // adopted (restart) or cancelled.
        <div className="save-warn" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>
            {t("Um backup restaurado está esperando o próximo boot — tudo o que você fizer até lá será descartado quando o Yard reabrir.")}
          </span>
          <button className="btn btn--sm" onClick={() => void restartIntoBackup()}>
            {t("Reiniciar agora")}
          </button>
          <button className="btn btn--sm" onClick={() => void cancelBackupRestore()}>
            {t("Cancelar restauração")}
          </button>
        </div>
      )}
      {updateOffer && (
        // A new release, signed and ready. The bar stays until it is installed
        // or ignored — the same shape as the backup warning, in the chrome's
        // blue: this is news, not danger.
        <div className="save-warn save-warn--info" role="status">
          <Download size={13} aria-hidden="true" />
          <span>
            {t("Versão {version} do Yard disponível — instale e reinicie quando quiser.", {
              version: updateOffer,
            })}
          </span>
          <button className="btn btn--sm btn--primary" onClick={() => void installUpdate()}>
            {t("Instalar e reiniciar")}
          </button>
          <button className="btn btn--sm" onClick={() => useUpdater.getState().skip()}>
            {t("Ignorar esta versão")}
          </button>
        </div>
      )}
      <div
        className="app-body"
        data-sidebar={sidebarOpen ? "open" : "closed"}
        data-changes={changesOpen ? "open" : "closed"}
        data-bench={benchOpen ? "open" : "closed"}
      >
        {sidebarOpen && <ProjectSidebar />}
        <main className="workspace">
          {notesOpen && notesCenter ? (
            // The notebook in its central place takes the whole area the
            // grid would get — the panels and sidebar around it keep working.
            <Overlay
              where={t("o caderno")}
              fallback={<LoadingSurface label="Abrindo o caderno" />}
            >
              <NotesCenter />
            </Overlay>
          ) : activeGroupId ? (
            <WorkspaceGrid groupId={activeGroupId} />
          ) : (
            <div
              className="grid-empty"
              // The app's first screen: with no project, right-click here
              // offers exactly what it asks for.
              onContextMenu={(e) => {
                e.preventDefault();
                setWelcomeMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {welcomeMenu && (
                <ContextMenu
                  anchor={welcomeMenu}
                  onClose={() => setWelcomeMenu(null)}
                  items={[
                    {
                      id: "add",
                      label: t("Adicionar projeto"),
                      icon: <FolderPlus size={13} />,
                      onSelect: () => openModal("new-project"),
                    },
                    {
                      id: "palette",
                      label: t("Paleta de comandos"),
                      shortcut: "Ctrl+P",
                      onSelect: () => useUI.getState().openPalette(),
                    },
                    { kind: "sep" },
                    {
                      id: "prefs",
                      label: t("Configurações"),
                      shortcut: "Ctrl+,",
                      onSelect: () => openModal("preferences"),
                    },
                  ]}
                />
              )}
              <div className="welcome">
                <img
                  className="welcome-mark"
                  src="/yard-app-icon.png"
                  alt=""
                  aria-hidden="true"
                />
                <h2>
                  {projects.length === 0
                    ? t("Comece pela pasta de um projeto")
                    : t("Escolha um grupo para começar")}
                </h2>
                <p>
                  {projects.length === 0
                    ? t("O Yard roda as CLIs de agentes dentro dessa pasta e acompanha o que elas mexem no disco.")
                    : t("Cada grupo é um conjunto de CLIs sobre o mesmo projeto. Selecione um na barra lateral.")}
                </p>
                {projects.length === 0 && (
                  <button
                    className="btn btn--primary"
                    onClick={() => openModal("new-project")}
                  >
                    <FolderPlus size={13} /> {t("Adicionar projeto")}
                  </button>
                )}
                <div className="welcome-hints">
                  {/* With zero projects Ctrl+T ends in "add a project first" —
                      teaching it here made the very first flow a dead end. */}
                  {projects.length > 0 && (
                    <span className="welcome-hint">
                      <kbd>Ctrl</kbd> + <kbd>T</kbd> {t("abre um terminal")}
                    </span>
                  )}
                  <span className="welcome-hint">
                    <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>H</kbd> {t("lista os atalhos")}
                  </span>
                </div>
              </div>
            </div>
          )}
        </main>
        {changesOpen && (
          <Overlay where={t("o painel de alterações")} fallback={<LoadingPane paneSide="changes" />}>
            <ChangesPanel />
          </Overlay>
        )}
        {benchOpen && (
          <Overlay where={t("a bancada")} fallback={<LoadingPane paneSide="bench" />}>
            <BenchPanel />
          </Overlay>
        )}
      </div>

      <Overlay where={t("o Ao Vivo")} fallback={<LoadingOverlay />}>
        {liveOpen && <LiveView />}
      </Overlay>
      <Overlay where={t("o visualizador de diff")} fallback={<LoadingOverlay />}>
        {viewerOpen && <DiffViewer />}
      </Overlay>
      <Overlay where={t("o caderno")} fallback={<LoadingOverlay />}>
        {notesOpen && !notesCenter && <NotesView />}
      </Overlay>
      <Overlay where={t("o editor")} fallback={<LoadingOverlay />}>
        {editorOpen && <CodeEditor />}
      </Overlay>
      <Overlay where={t("o compositor")} fallback={<LoadingOverlay />}>
        {composerOpen && <Composer />}
      </Overlay>
      <Overlay where={t("a Busca")} fallback={<LoadingOverlay />}>
        {paletteOpen && <Palette />}
      </Overlay>
      <Overlay where={t("esta janela")} fallback={<LoadingOverlay />}>
        {modal === "new-terminal" && <NewTerminalModal />}
        {modal === "new-portal" && <NewPortalModal />}
        {modal === "new-project" && <NewProjectModal />}
        {modal === "new-floor" && <NewFloorModal />}
        {modal === "new-task" && <FanoutModal />}
        {modal === "land-floor" && <LandModal />}
        {modal === "close-floor" && <CloseFloorModal />}
        {modal === "compare-floors" && <CompareModal />}
        {modal === "project-style" && (
          <ProjectStyleModal
            projectId={
              (modalPayload as { projectId?: string } | null)?.projectId ?? ""
            }
          />
        )}
        {modal === "preferences" && <SettingsScreen />}
        {modal === "extensions" && <ExtensionsModal />}
        {modal === "shortcuts" && <ShortcutsModal />}
        {modal === "role" && <RoleModal />}
        {modal === "routines" && <RoutinesModal />}
        {modal === "scores" && <ScoresModal />}
        {modal === "flow" && <FlowModal />}
        {modal === "scm-confirm" && <ScmConfirmModal />}
        {modal === "onboarding" && <OnboardingModal />}
        {modal === "costs" && <CostsModal />}
        {modal === "shoulder" && <ShoulderModal />}
        {modal === "transcript" && <TranscriptModal />}
        {modal === "sessions" && (
          <SessionsModal
            projectPath={
              (modalPayload as { projectPath?: string } | null)?.projectPath ?? ""
            }
          />
        )}
      </Overlay>

      {toasts.length > 0 && (
        <div className="toast-stack">
          {toastOverflow > 0 && (
            <div className="toast-overflow" role="status">
              {tn(toastOverflow, "+{n} aviso anterior saiu da pilha", "+{n} avisos anteriores saíram da pilha")}
            </div>
          )}
          {toasts.map((t, i) => (
            <ToastBar
              key={t.id}
              toast={t}
              slot={i}
              onDismiss={() => dismissToast(t.id)}
            />
          ))}
        </div>
      )}
      <AgentAnnouncer />
      {/* Last on purpose: it is the net that catches the right-click no
          surface claimed. */}
      <GlobalMenu />
    </div>
  );
}

/**
 * Screen-reader channel for the badges: "waiting for an answer" and
 * "finished" only existed as coloured dots and tooltips, so the product's
 * central signal never reached assistive tech. Announces transitions only —
 * whatever is already blocked at mount stays silent.
 */
/**
 * What shows while a lazy surface's chunk has not arrived.
 *
 * It was `null`: pressing `Ctrl+B` or opening Preferences for the first time
 * produced **nothing** on screen until the file came from disk. It is usually
 * fast, but "nothing happened" is the wrong reading of "it is coming" — and
 * the first reaction of whoever sees no response is to press again.
 *
 * There are three because there are three shapes of waiting: the central
 * area, the side column (which has to be born at the width already stored,
 * otherwise the layout jumps) and the overlay that covers everything.
 */
function LoadingSurface({ label }: { label: string }) {
  return (
    <div className="surface-loading" role="status">
      <Loader2 size={16} className="spin" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

function LoadingPane({ paneSide: side }: { paneSide: "changes" | "bench" }) {
  const t = useT();
  const width = useUI((s) =>
    side === "changes" ? s.prefs.changesWidth : s.prefs.benchWidth,
  );
  return (
    <aside className="panel-loading" style={{ width: width }} role="status">
      <Loader2 size={15} className="spin" aria-hidden="true" />
      <span className="sr-only">{t("Abrindo o painel…")}</span>
    </aside>
  );
}

function LoadingOverlay() {
  const t = useT();
  return (
    <div className="overlay-loading" role="status">
      <Loader2 size={18} className="spin" aria-hidden="true" />
      <span className="sr-only">{t("Abrindo…")}</span>
    </div>
  );
}

function AgentAnnouncer() {
  const t = useT();
  const [message, setMessage] = useState("");
  useEffect(() => {
    return useTerminals.subscribe((s, prev) => {
      for (const [id, rt] of Object.entries(s.byId)) {
        const before = prev.byId[id];
        if (rt.blocked === before?.blocked && rt.finished === before?.finished) {
          continue;
        }
        const row = useProjects.getState().terminals.find((t) => t.id === id);
        const itemName = row ? baseName(row) : t("Um agente");
        if (rt.blocked && !before?.blocked) {
          // A trailing space forces a DOM change when the same agent blocks
          // twice in a row — identical text would not be re-announced.
          setMessage((m) => {
            const newValue = t("{name} está esperando uma resposta sua", { name: itemName });
            return m === newValue ? `${newValue} ` : newValue;
          });
          return;
        }
        if (rt.finished && !before?.finished && !rt.blocked) {
          setMessage((m) => {
            const next = t("{name} terminou de trabalhar", { name: itemName });
            return m === next ? `${next} ` : next;
          });
          return;
        }
      }
    });
  }, []);
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {message}
    </div>
  );
}

/**
 * The toast sits at the bottom of the window, where a portal card often is —
 * and a portal's page is an OS window over the DOM, so "an error appeared and
 * nobody saw it" is a real outcome. Publishing the rectangle has the engine
 * cut the page open exactly there.
 *
 * A component of its own so the rectangle is published and retired with each
 * toast — and, now that notices stack, so each one publishes its own: the
 * occluder key carries the id, otherwise the second toast would overwrite the
 * first one's rectangle and the portal would paint over what is still on
 * screen.
 */
function ToastBar({
  toast,
  slot,
  onDismiss,
}: {
  toast: Toast;
  /** Position in the stack — see the occluder key below. */
  slot: number;
  onDismiss: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Keyed by **position**, not by id: dismissing the notice below moves this
  // one down, and a `ResizeObserver` does not fire for a move. Re-keying on the
  // slot re-publishes the rectangle (and clears the slot that emptied), so the
  // hole cut in a portal underneath keeps up with the stack.
  useOccluder(`toast-${slot}`, ref);
  return (
    <div
      ref={ref}
      className={`toast toast--${toast.kind}`}
      role="status"
      aria-live={toast.kind === "error" ? "assertive" : "polite"}
    >
      <span>{toast.message}</span>
      <button className="icon-btn" aria-label={t("Dispensar aviso")} onClick={onDismiss}>
        <X size={12} />
      </button>
    </div>
  );
}
