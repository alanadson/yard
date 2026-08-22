/**
 * "Files" panel — the window onto what the CLI is doing on disk.
 *
 * Two tabs:
 * - **Live**: feed of files touched in the active project, in near
 *   real time (~250 ms batches from the Rust watcher).
 * - **Changes**: the review — what changed and what is new according to git,
 *   with an inline diff per file. A project without git falls back to a
 *   session summary built from the feed itself.
 *
 * Integration with the large viewer (`DiffViewer`):
 * - clicking a row (review or feed) opens the file in the "larger tab";
 * - hovering opens a floating preview (peek) beside it;
 * - the chevron still expands the inline diff, for quick checks.
 *
 * The panel is a *projection* of the stores; nothing here owns process
 * state (golden rule of §4.3).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import "./changes.css";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Eraser,
  GitBranch,
  RotateCw,
  X,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { FileKindBadge, GitStatusBadge, PathLabel } from "../FileMarks";
import { SCM_ROWS_PAGE, pageRows } from "../../lib/scmGroups";
import { Resizer } from "../Resizer";
import { changedFileMenu, changesPanelMenu } from "../../lib/changesMenu";
import { copyText } from "../../lib/clipboard";
import { ipc } from "../../lib/ipc";
import { useEditor } from "../../stores/editorStore";
import { diffLineClass } from "../../lib/diff";
import { ago } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import type { ChangedFile, FileDiff } from "../../lib/ipc";
import {
  fetchDiff,
  useChanges,
  type LiveEntry,
} from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";
import {
  useUI,
  CHANGES_MAX,
  CHANGES_MIN,
  DEFAULT_PREFS,
} from "../../stores/uiStore";

// Stable reference for the Zustand selector: returning a new `[]` on every
// call would send useSyncExternalStore into a re-render loop.
const EMPTY_LIVE: LiveEntry[] = [];

/** Wait with the mouse still before opening the preview. */
const PEEK_DELAY_MS = 400;
/** How many diff lines the preview shows at most. */
const PEEK_LINES = 42;

interface PeekTarget {
  file: ChangedFile;
  top: number;
}

interface RowCallbacks {
  onOpen: (path: string) => void;
  onHover: (file: ChangedFile, e: ReactMouseEvent) => void;
  onLeave: () => void;
}

export function ChangesPanel() {
  const tab = useChanges((s) => s.tab);
  const setTab = useChanges((s) => s.setTab);
  const toggle = useChanges((s) => s.toggle);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const width = useUI((s) => s.prefs.changesWidth);
  const setPref = useUI((s) => s.setPref);
  const setPrefLocal = useUI((s) => s.setPrefLocal);

  // Root watched by the backend: the active floor's worktree, when there is
  // one. Falls back to the project path only while the first `ensureWatch` runs.
  const root =
    useChanges((s) =>
      activeProjectId ? s.watched[activeProjectId] : undefined,
    ) ?? project?.path;

  const live = useChanges((s) =>
    activeProjectId
      ? (s.liveByProject[activeProjectId] ?? EMPTY_LIVE)
      : EMPTY_LIVE,
  );
  const dropped = useChanges((s) =>
    activeProjectId ? (s.droppedByProject[activeProjectId] ?? 0) : 0,
  );
  const git = useChanges((s) =>
    activeProjectId ? s.gitByProject[activeProjectId] : undefined,
  );
  const gitLoading = useChanges((s) =>
    activeProjectId ? (s.gitLoading[activeProjectId] ?? false) : false,
  );

  // Reloads the git snapshot when the panel opens and when the project or
  // the active floor's root changes.
  useEffect(() => {
    if (project && root) void useChanges.getState().refreshGit(project.id, root);
  }, [project?.id, root]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- peek (floating preview) --------------------------------------------
  // One instance for the whole panel; rows request it via callbacks.
  const panelRef = useRef<HTMLElement>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const viewerOpen = useChanges((s) => s.viewer != null);

  const cancelPeek = useCallback(() => {
    if (peekTimer.current) {
      clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
    setPeek(null);
  }, []);

  const requestPeek = useCallback(
    (file: ChangedFile, e: ReactMouseEvent) => {
      if (!git?.isRepo || useChanges.getState().viewer) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (peekTimer.current) clearTimeout(peekTimer.current);
      peekTimer.current = setTimeout(() => {
        peekTimer.current = null;
        const top = Math.max(8, Math.min(rect.top, window.innerHeight - 380));
        setPeek({ file, top });
      }, PEEK_DELAY_MS);
    },
    [git?.isRepo],
  );

  // The peek does not survive a tab/project switch or an open viewer.
  useEffect(() => cancelPeek(), [tab, activeProjectId, viewerOpen, cancelPeek]);

  const openViewer = useCallback(
    (path: string) => {
      if (!activeProjectId || !git?.isRepo) return;
      cancelPeek();
      useChanges.getState().openViewer(activeProjectId, path);
    },
    [activeProjectId, git?.isRepo, cancelPeek],
  );

  /** ChangedFile for a feed path: the git summary when it has already arrived,
   *  otherwise a pseudo-modified (peek/viewer correct themselves when it does). */
  const fileFor = useCallback(
    (path: string): ChangedFile =>
      git?.files.find((f) => f.path === path) ?? {
        path,
        origPath: null,
        status: "modified",
        staged: false,
        additions: null,
        deletions: null,
        binary: false,
        index: "none",
        worktree: "modified",
        conflict: null,
      },
    [git],
  );

  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(
    null,
  );
  const showToast = useUI.getState().showToast;

  /** The menu actions, the same for a row and for the background. */
  const menuActions = {
    openDiff: openViewer,
    openInEditor: (path: string) => {
      void useEditor
        .getState()
        .openFile(path)
        .catch((e) => showToast(`Não consegui abrir: ${e}`, "error"));
    },
    copyPath: (theText: string) => {
      void copyText(theText).then((ok) =>
        showToast(ok ? "Caminho copiado." : "Não consegui copiar.", ok ? "info" : "error"),
      );
    },
    reveal: (osPath: string) => {
      void ipc.revealPath(osPath).catch((e) => showToast(String(e), "error"));
    },
    refresh: () => {
      if (project && root) void useChanges.getState().refreshGit(project.id, root);
    },
    clearFeed: () => {
      if (activeProjectId) useChanges.getState().clearLive(activeProjectId);
    },
    close: toggle,
  };

  /**
   * One handler for the whole panel: it finds the row through
   * `data-changes-path` and, when the click landed outside any of them,
   * answers for the panel. Threading an `onMenu` down four component levels
   * would give the same result with four more props.
   */
  const openMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const row =
      e.target instanceof Element ? e.target.closest("[data-changes-path]") : null;
    const path = row?.getAttribute("data-changes-path");
    const anchor = { x: e.clientX, y: e.clientY };
    setMenu({
      anchor,
      entries: path
        ? changedFileMenu(fileFor(path), { root: root ?? project?.path ?? null }, menuActions)
        : changesPanelMenu(
            { tab, hasRepo: git?.isRepo === true, feedCount: live.length },
            menuActions,
          ),
    });
  };

  return (
    <aside
      className="changes"
      style={{ width }}
      aria-label="Arquivos e alterações"
      ref={panelRef}
      onContextMenu={openMenu}
    >
      <Resizer
        side="left"
        width={width}
        min={CHANGES_MIN}
        max={CHANGES_MAX}
        defaultWidth={DEFAULT_PREFS.changesWidth}
        label="Largura do painel de arquivos"
        onResize={(w) => setPrefLocal("changesWidth", w)}
        onCommit={(w) => setPref("changesWidth", w)}
      />

      <div className="changes-header">
        <span className="changes-title">
          Arquivos
          {project && <small data-tip={project.path}>{project.name}</small>}
        </span>
        <div className="changes-actions">
          {tab === "live" ? (
            <button
              className="icon-btn"
              data-tip-at="right" data-tip="Limpar o feed"
              aria-label="Limpar o feed"
              onClick={() =>
                activeProjectId && useChanges.getState().clearLive(activeProjectId)
              }
            >
              <Eraser size={13} />
            </button>
          ) : (
            <button
              className={`icon-btn ${gitLoading ? "is-busy" : ""}`}
              data-tip-at="right" data-tip="Atualizar (git status)"
              aria-label="Atualizar o estado do repositório"
              onClick={() =>
                project &&
                root &&
                void useChanges.getState().refreshGit(project.id, root)
              }
            >
              <RotateCw size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            data-tip-at="right" data-tip="Fechar (Ctrl+Shift+D)"
            aria-label="Fechar o painel de arquivos"
            onClick={toggle}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="changes-tabs" role="tablist" aria-label="Visão dos arquivos">
        <button
          role="tab"
          id="changes-tab-live"
          aria-selected={tab === "live"}
          aria-controls="changes-panel-body"
          tabIndex={tab === "live" ? 0 : -1}
          className={tab === "live" ? "is-active" : ""}
          onClick={() => setTab("live")}
        >
          Ao vivo
          {live.length > 0 && <span className="changes-count">{live.length}</span>}
        </button>
        <button
          role="tab"
          id="changes-tab-review"
          aria-selected={tab === "review"}
          aria-controls="changes-panel-body"
          tabIndex={tab === "review" ? 0 : -1}
          className={tab === "review" ? "is-active" : ""}
          onClick={() => setTab("review")}
        >
          Alterações
          {git?.isRepo && git.files.length > 0 && (
            <span className="changes-count">{git.files.length}</span>
          )}
        </button>
      </div>

      {/* The two tabs share one panel, so it is one `tabpanel` whose label
          follows the selected tab. Without this the tabs announced a
          relationship to nothing. */}
      <div
        id="changes-panel-body"
        role="tabpanel"
        aria-labelledby={tab === "live" ? "changes-tab-live" : "changes-tab-review"}
        className="changes-panelbody"
      >
        {!project ? (
          <div className="changes-empty">
            Nenhum projeto ativo.
            <small>Escolha um projeto na barra lateral para acompanhar os arquivos.</small>
          </div>
        ) : tab === "live" ? (
          <LiveFeed
            entries={live}
            dropped={dropped}
            clickable={git?.isRepo === true}
            onOpen={openViewer}
            onHover={(path, e) => requestPeek(fileFor(path), e)}
            onLeave={cancelPeek}
          />
        ) : (
          <Review
            project={{ id: project.id, path: root ?? project.path }}
            live={live}
            onOpen={openViewer}
            onHover={requestPeek}
            onLeave={cancelPeek}
          />
        )}
      </div>

      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          items={menu.entries}
          onClose={() => setMenu(null)}
        />
      )}

      {peek && project && (
        <DiffPeek
          projectId={project.id}
          root={root ?? project.path}
          target={peek}
          panelLeft={panelRef.current?.getBoundingClientRect().left ?? 0}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// "Live" tab
// ---------------------------------------------------------------------------

function LiveFeed({
  entries,
  dropped,
  clickable,
  onOpen,
  onHover,
  onLeave,
}: {
  entries: LiveEntry[];
  dropped: number;
  clickable: boolean;
  onOpen: (path: string) => void;
  onHover: (path: string, e: ReactMouseEvent) => void;
  onLeave: () => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="changes-empty">
        <Activity size={20} aria-hidden="true" />
        Nenhuma atividade ainda.
        <small>
          Os arquivos que a CLI criar, editar ou apagar neste projeto aparecem
          aqui na hora.
        </small>
      </div>
    );
  }
  return (
    <div className="changes-body">
      {dropped > 0 && (
        <div className="changes-note">
          +{dropped} evento(s) além do teto de uma rajada não listados.
        </div>
      )}
      <ul className="feed-list">
        {entries.map((e) => (
          <FeedRow
            key={e.path}
            entry={e}
            clickable={clickable}
            onOpen={onOpen}
            onHover={onHover}
            onLeave={onLeave}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * One row of the feed, memoized. Everything that changes by the clock lives
 * in `<Ago>` below, so time passing no longer re-renders 300 rows of badges
 * and path labels.
 */
const FeedRow = memo(function FeedRow({
  entry: e,
  clickable,
  onOpen,
  onHover,
  onLeave,
}: {
  entry: LiveEntry;
  clickable: boolean;
  onOpen: (path: string) => void;
  onHover: (path: string, e: ReactMouseEvent) => void;
  onLeave: () => void;
}) {
  return (
    <li
      className={`feed-row ${clickable ? "feed-row--clickable" : ""}`}
      // The panel's menu is delegated: it finds the row through this attribute
      // instead of every level threading an `onMenu` nobody else uses.
      data-changes-path={e.path}
      data-tip={clickable ? `${e.path} — clique abre o diff completo` : e.path}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen(e.path) : undefined}
      onKeyDown={
        clickable
          ? (ev) => {
              // Space too: a `role="button"` is expected to answer both, and
              // this row only answered Enter.
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onOpen(e.path);
              }
            }
          : undefined
      }
      onMouseEnter={clickable ? (ev) => onHover(e.path, ev) : undefined}
      onMouseLeave={clickable ? onLeave : undefined}
    >
      <FileKindBadge kind={e.kind} />
      <PathLabel path={e.path} deleted={e.kind === "deleted"} />
      <span className="feed-meta">
        {e.count > 1 && <span className="feed-count">×{e.count}</span>}
        <Ago at={e.at} />
      </span>
    </li>
  );
});

/** The relative age — the only part of a feed row that ticks. */
function Ago({ at }: { at: number }) {
  return <>{ago(useNow(5_000) - at)}</>;
}

// ---------------------------------------------------------------------------
// "Changes" tab
// ---------------------------------------------------------------------------

function Review({
  project,
  live,
  onOpen,
  onHover,
  onLeave,
}: {
  project: { id: string; path: string };
  live: LiveEntry[];
} & RowCallbacks) {
  const git = useChanges((s) => s.gitByProject[project.id]);

  // One pass instead of three: this runs on every render of the panel, and
  // the panel re-renders whenever the agent touches a file.
  const groups = useMemo(() => {
    const modified: ChangedFile[] = [];
    const added: ChangedFile[] = [];
    const deleted: ChangedFile[] = [];
    for (const f of git?.files ?? []) {
      if (f.status === "deleted") deleted.push(f);
      else if (f.status === "added" || f.status === "untracked") added.push(f);
      else modified.push(f);
    }
    return { alterados: modified, novos: added, excluidos: deleted };
  }, [git]);

  if (!git) {
    return (
      <div className="changes-empty">Lendo o estado do repositório…</div>
    );
  }

  if (!git.isRepo) {
    return <SessionReview live={live} />;
  }

  if (git.files.length === 0) {
    return (
      <div className="changes-empty">
        <Check size={20} aria-hidden="true" />
        Árvore limpa.
        <small>Nada mudou desde o último commit.</small>
      </div>
    );
  }

  return (
    <div className="changes-body">
      <div className="review-summary">
        {git.branch && (
          <span className="review-chip" data-tip="Branch atual">
            <GitBranch size={11} aria-hidden="true" />
            {git.branch}
          </span>
        )}
        <span className="review-chip">
          {git.files.length} {git.files.length === 1 ? "arquivo" : "arquivos"}
        </span>
        <span
          className="review-chip"
          data-tip-wrap=""
          data-tip={
            git.uncounted > 0
              ? `Linhas somadas e removidas. ${git.uncounted} arquivo(s) novo(s) além do teto de contagem ficaram de fora — o total é um piso.`
              : "Linhas somadas e removidas"
          }
        >
          {/* The backend stops counting lines of new files past its cap. The
              reticence is the point: showing a partial sum as if it were the
              total is worse than admitting it is a floor. */}
          <span className="stat-add">
            +{git.additions}
            {git.uncounted > 0 && "…"}
          </span>
          <span className="stat-del">−{git.deletions}</span>
        </span>
      </div>

      {git.uncounted > 0 && (
        <div className="changes-note">
          {git.uncounted} arquivo(s) novo(s) além do teto: aparecem na lista, mas
          as linhas deles não entram no total.
        </div>
      )}

      <ReviewSection
        title="Alterados"
        files={groups.alterados}
        projectId={project.id}
        root={project.path}
        onOpen={onOpen}
        onHover={onHover}
        onLeave={onLeave}
      />
      <ReviewSection
        title="Novos"
        files={groups.novos}
        projectId={project.id}
        root={project.path}
        onOpen={onOpen}
        onHover={onHover}
        onLeave={onLeave}
      />
      <ReviewSection
        title="Excluídos"
        files={groups.excluidos}
        projectId={project.id}
        root={project.path}
        onOpen={onOpen}
        onHover={onHover}
        onLeave={onLeave}
      />
    </div>
  );
}

function ReviewSection({
  title,
  files,
  projectId,
  root,
  onOpen,
  onHover,
  onLeave,
}: {
  title: string;
  files: ChangedFile[];
  projectId: string;
  root: string;
} & RowCallbacks) {
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());
  // The same window as the Source Control tab, for the same reason: every row
  // here is two buttons, two SVGs and two `data-tip` balloons, and a repository
  // with thousands of touched files drew them all at once -- the list froze on
  // open and on every tick of the watcher.
  const [shown, setShown] = useState(SCM_ROWS_PAGE);
  const page = pageRows(files, shown);
  if (files.length === 0) return null;

  const toggleInline = (path: string) =>
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <section className="review-section">
      <h3 className="review-section-title">
        {title} <span className="changes-count">{files.length}</span>
      </h3>
      <ul className="file-list">
        {page.rows.map((f) => {
          const open = openPaths.has(f.path);
          const itemName = f.path.split("/").pop() ?? f.path;
          return (
            <li key={f.path}>
              {/* Chevron and row are siblings. Nesting the chevron inside the
                  row's button was invalid HTML — the browser routed its click
                  to the outer button — and made expanding the inline diff a
                  mouse-only affordance. */}
              <div className="file-row-wrap" data-changes-path={f.path}>
                <button
                  type="button"
                  className="file-chevron"
                  aria-expanded={open}
                  aria-label={
                    open ? `Recolher o diff de ${itemName}` : `Expandir o diff de ${itemName}`
                  }
                  data-tip={open ? "Recolher o diff inline" : "Expandir o diff inline"}
                  onClick={() => toggleInline(f.path)}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <button
                  className="file-row"
                  onClick={() => onOpen(f.path)}
                  onMouseEnter={(e) => onHover(f, e)}
                  onMouseLeave={onLeave}
                  data-tip-wrap="" data-tip={`${f.path}${f.staged ? " (staged)" : ""} — clique abre o diff completo`}
                >
                  <GitStatusBadge status={f.status} />
                  <PathLabel path={f.path} deleted={f.status === "deleted"} />
                  <span className="file-stats">
                    {f.binary ? (
                      <span className="stat-bin">bin</span>
                    ) : (
                      <>
                        {f.additions != null && (
                          <span className="stat-add">+{f.additions}</span>
                        )}
                        {f.deletions != null && f.deletions > 0 && (
                          <span className="stat-del">−{f.deletions}</span>
                        )}
                      </>
                    )}
                  </span>
                </button>
              </div>
              {f.origPath && <div className="file-orig">era {f.origPath}</div>}
              {open && <DiffView projectId={projectId} root={root} file={f} />}
            </li>
          );
        })}
      </ul>
      {page.hidden > 0 && (
        <button className="list-more" onClick={() => setShown((n) => n + SCM_ROWS_PAGE)}>
          Mostrar mais {Math.min(page.hidden, SCM_ROWS_PAGE)}
          <span className="list-more-rest">
            {page.hidden} arquivo{page.hidden === 1 ? "" : "s"} sem desenhar
          </span>
        </button>
      )}
    </section>
  );
}

/**
 * Inline diff of one file.
 *
 * Goes through `fetchDiff` like the peek and the large viewer do — it used to
 * call `gitFileDiff` directly, which put it outside both the LRU (ten expanded
 * files meant ten `git` processes on every open) and the per-project
 * invalidation. The visible half of that was worse than the cost: the large
 * viewer refreshed itself while the agent edited and this one froze, so two
 * views of the same file showed different content with nothing saying which
 * was stale. Depending on the git summary is what re-runs it.
 */
function DiffView({
  projectId,
  root,
  file,
}: {
  projectId: string;
  root: string;
  file: ChangedFile;
}) {
  const git = useChanges((s) => s.gitByProject[projectId]);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lines = useMemo(() => diff?.text.split("\n") ?? [], [diff]);
  const visibleLines = lines.slice(0, 1_500);
  const clipped = lines.length > visibleLines.length;

  useEffect(() => {
    let alive = true;
    setError(null);
    // No `setDiff(null)` here: the row is keyed by path, so this only ever
    // reloads the same file. Blanking it would flash "carregando" on every
    // `git status` tick while an agent works.
    fetchDiff(
      projectId,
      root,
      {
        path: file.path,
        untracked: file.status === "untracked",
        origPath: file.origPath,
      },
      false,
    )
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [projectId, root, file.path, file.status, file.origPath, git]);

  if (error) return <div className="diff-note diff-note--error">{error}</div>;
  if (!diff) return <div className="diff-note">carregando diff…</div>;
  if (diff.isBinary) return <div className="diff-note">arquivo binário.</div>;
  if (diff.text.trim() === "")
    return <div className="diff-note">sem diferenças.</div>;

  return (
    <div className="diff">
      {diff.truncated && (
        <div className="diff-note">diff truncado — arquivo grande demais.</div>
      )}
      {clipped && (
        <div className="diff-note">
          Mostrando 1.500 de {lines.length.toLocaleString("pt-BR")} linhas — abra o diff completo
          para continuar.
        </div>
      )}
      <pre>
        {visibleLines.map((line, i) => (
          <span key={i} className={diffLineClass(line)}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Without git: groups the session feed itself, so the panel is not silent. */
function SessionReview({ live }: { live: LiveEntry[] }) {
  const groups = useMemo(
    () => ({
      Alterados: live.filter((e) => e.kind === "modified"),
      Novos: live.filter((e) => e.kind === "created"),
      Excluídos: live.filter((e) => e.kind === "deleted"),
    }),
    [live],
  );

  if (live.length === 0) {
    return (
      <div className="changes-empty">
        <GitBranch size={20} aria-hidden="true" />
        Este projeto não é um repositório git.
        <small>
          Sem baseline para comparar; quando algo for tocado nesta sessão, o
          resumo aparece aqui.
        </small>
      </div>
    );
  }

  return (
    <div className="changes-body">
      <div className="changes-note">
        Projeto sem git — resumo do que a sessão tocou, sem diffs.
      </div>
      {Object.entries(groups).map(([title, entries]) =>
        entries.length === 0 ? null : (
          <section className="review-section" key={title}>
            <h3 className="review-section-title">
              {title} <span className="changes-count">{entries.length}</span>
            </h3>
            <ul className="file-list">
              {entries.map((e) => (
                <li key={e.path} className="file-row file-row--static" data-tip={e.path}>
                  <FileKindBadge kind={e.kind} />
                  <PathLabel path={e.path} deleted={e.kind === "deleted"} />
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// peek — floating preview beside the panel
// ---------------------------------------------------------------------------

function DiffPeek({
  projectId,
  root,
  target,
  panelLeft,
}: {
  projectId: string;
  root: string;
  target: PeekTarget;
  panelLeft: number;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { file } = target;

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    fetchDiff(
      projectId,
      root,
      {
        path: file.path,
        untracked: file.status === "untracked",
        origPath: file.origPath,
      },
      false,
    )
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [projectId, root, file.path, file.status, file.origPath]);

  const lines = useMemo(() => {
    if (!diff) return [];
    const all = diff.text.split("\n");
    if (all[all.length - 1] === "") all.pop();
    return all;
  }, [diff]);

  const shown = lines.slice(0, PEEK_LINES);
  const remaining = lines.length - shown.length;

  return (
    <div
      className="peek"
      style={{ top: target.top, right: window.innerWidth - panelLeft + 8 }}
    >
      <div className="peek-header">
        <GitStatusBadge status={file.status} />
        <PathLabel path={file.path} deleted={file.status === "deleted"} />
        <span className="file-stats">
          {file.additions != null && (
            <span className="stat-add">+{file.additions}</span>
          )}
          {file.deletions != null && file.deletions > 0 && (
            <span className="stat-del">−{file.deletions}</span>
          )}
        </span>
      </div>
      <div className="peek-body">
        {error ? (
          <div className="diff-note diff-note--error">{error}</div>
        ) : !diff ? (
          <div className="diff-note">carregando…</div>
        ) : diff.isBinary ? (
          <div className="diff-note">arquivo binário.</div>
        ) : shown.length === 0 ? (
          <div className="diff-note">sem diferenças.</div>
        ) : (
          <pre>
            {shown.map((line, i) => (
              <span key={i} className={diffLineClass(line)}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        )}
      </div>
      {remaining > 0 && (
        <div className="peek-more">
          +{remaining} linha(s) — clique para abrir o diff completo
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------
