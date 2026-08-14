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

import { FileKindBadge, GitStatusBadge, PathLabel } from "../FileMarks";
import { Resizer } from "../Resizer";
import { diffLineClass } from "../../lib/diff";
import { ago } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { ipc, type ChangedFile, type FileDiff } from "../../lib/ipc";
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
      },
    [git],
  );

  return (
    <aside
      className="changes"
      style={{ width }}
      aria-label="Arquivos e alterações"
      ref={panelRef}
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

      <div className="changes-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "live"}
          className={tab === "live" ? "is-active" : ""}
          onClick={() => setTab("live")}
        >
          Ao vivo
          {live.length > 0 && <span className="changes-count">{live.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={tab === "review"}
          className={tab === "review" ? "is-active" : ""}
          onClick={() => setTab("review")}
        >
          Alterações
          {git?.isRepo && git.files.length > 0 && (
            <span className="changes-count">{git.files.length}</span>
          )}
        </button>
      </div>

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
      data-tip={clickable ? `${e.path} — clique abre o diff completo` : e.path}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen(e.path) : undefined}
      onKeyDown={
        clickable
          ? (ev) => {
              if (ev.key === "Enter") onOpen(e.path);
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
  const grupos = useMemo(() => {
    const alterados: ChangedFile[] = [];
    const novos: ChangedFile[] = [];
    const excluidos: ChangedFile[] = [];
    for (const f of git?.files ?? []) {
      if (f.status === "deleted") excluidos.push(f);
      else if (f.status === "added" || f.status === "untracked") novos.push(f);
      else alterados.push(f);
    }
    return { alterados, novos, excluidos };
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
            <GitBranch size={11} />
            {git.branch}
          </span>
        )}
        <span className="review-chip">
          {git.files.length} {git.files.length === 1 ? "arquivo" : "arquivos"}
        </span>
        <span className="review-chip" data-tip="Linhas somadas e removidas">
          <span className="stat-add">+{git.additions}</span>
          <span className="stat-del">−{git.deletions}</span>
        </span>
      </div>

      <ReviewSection
        title="Alterados"
        files={grupos.alterados}
        root={project.path}
        onOpen={onOpen}
        onHover={onHover}
        onLeave={onLeave}
      />
      <ReviewSection
        title="Novos"
        files={grupos.novos}
        root={project.path}
        onOpen={onOpen}
        onHover={onHover}
        onLeave={onLeave}
      />
      <ReviewSection
        title="Excluídos"
        files={grupos.excluidos}
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
  root,
  onOpen,
  onHover,
  onLeave,
}: {
  title: string;
  files: ChangedFile[];
  root: string;
} & RowCallbacks) {
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());
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
        {files.map((f) => {
          const open = openPaths.has(f.path);
          return (
            <li key={f.path}>
              <button
                className="file-row"
                onClick={() => onOpen(f.path)}
                onMouseEnter={(e) => onHover(f, e)}
                onMouseLeave={onLeave}
                data-tip-wrap="" data-tip={`${f.path}${f.staged ? " (staged)" : ""} — clique abre o diff completo`}
              >
                <span
                  className="file-chevron"
                  role="button"
                  tabIndex={-1}
                  aria-expanded={open}
                  data-tip={open ? "Recolher o diff inline" : "Expandir o diff inline"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleInline(f.path);
                  }}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
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
              {f.origPath && <div className="file-orig">era {f.origPath}</div>}
              {open && <DiffView root={root} file={f} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Diff loaded on demand, on every expansion — always fresh. */
function DiffView({ root, file }: { root: string; file: ChangedFile }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    ipc
      .gitFileDiff(root, file.path, file.status === "untracked", file.origPath)
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root, file.path, file.status, file.origPath]);

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
      <pre>
        {diff.text.split("\n").map((line, i) => (
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
  const restantes = lines.length - shown.length;

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
      {restantes > 0 && (
        <div className="peek-more">
          +{restantes} linha(s) — clique para abrir o diff completo
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

