/**
 * DiffViewer — the "larger tab": a full-screen review of a single file.
 *
 * What it has beyond a common diff viewer:
 * - unified or side-by-side view, with line numbers on both sides and
 *   inline highlight of the span that changed;
 * - "whole file" mode (huge git context): see the change in the middle
 *   of the real file, not just the snippet;
 * - side rail with every changed file so you can navigate without going
 *   back to the panel (Alt+← / Alt+→ also switch);
 * - the diff UPDATES ITSELF while the agent works: each new `git status`
 *   invalidates the cache and reloads the open file, without closing anything.
 *
 * Process state stays in the backend; here it is only a projection (§4.3).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  WrapText,
  X,
} from "lucide-react";

import { GitStatusBadge, PathLabel } from "../FileMarks";
import { copyText } from "../../lib/clipboard";
import {
  parseUnifiedDiff,
  annotateIntraline,
  toSplitRows,
  type DiffHunk,
  type DiffLine,
  type ParsedDiff,
} from "../../lib/diff";
import { fileName } from "../../lib/paths";
import { ipc, type ChangedFile, type ChangesSummary, type FileDiff } from "../../lib/ipc";
import { fetchDiff, useChanges, type ViewerTarget } from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";

export function DiffViewer() {
  const viewer = useChanges((s) => s.viewer);
  if (!viewer) return null;
  return <ViewerInner key={`${viewer.projectId}|${viewer.path}`} target={viewer} />;
}

/** Same visual order as the panel: changed, new, deleted. */
function orderedFiles(git: ChangesSummary | undefined): ChangedFile[] {
  if (!git?.isRepo) return [];
  const by = (statuses: string[]) =>
    git.files.filter((f) => statuses.includes(f.status));
  return [
    ...by(["modified", "renamed", "conflicted"]),
    ...by(["added", "untracked"]),
    ...by(["deleted"]),
  ];
}

function ViewerInner({ target }: { target: ViewerTarget }) {
  const { projectId, path } = target;
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId));
  // Watched root (the active floor's worktree) — the diff comes from the same
  // repo the panel is showing, not necessarily from the ground.
  const root = useChanges((s) => s.watched[projectId]) ?? project?.path;
  const git = useChanges((s) => s.gitByProject[projectId]);
  const mode = useChanges((s) => s.viewerMode);
  const whole = useChanges((s) => s.viewerWhole);
  const wrap = useChanges((s) => s.viewerWrap);
  const close = useChanges((s) => s.closeViewer);

  const files = useMemo(() => orderedFiles(git), [git]);
  const idx = files.findIndex((f) => f.path === path);
  // Opened from the feed before git status catches up: treat as
  // modified (real diff against HEAD); when the summary arrives, the reload
  // effect corrects itself.
  const file: ChangedFile = files[idx] ?? {
    path,
    origPath: null,
    status: "modified",
    staged: false,
    additions: null,
    deletions: null,
    binary: false,
  };

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLElement | null)[]>([]);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    try {
      const d = await fetchDiff(
        projectId,
        root,
        {
          path: file.path,
          untracked: file.status === "untracked",
          origPath: file.origPath,
        },
        whole,
      );
      setDiff(d);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    // `file` is recreated on render; the primitive deps avoid a loop.
  }, [root, projectId, file.path, file.status, file.origPath, whole]);

  // Reloads when the target changes AND when a new `git status` arrives — that
  // is what keeps the diff alive while the agent keeps editing.
  useEffect(() => {
    void load();
  }, [load, git]);

  const nav = useCallback(
    (delta: number) => {
      if (files.length === 0) return;
      const cur = idx >= 0 ? idx : 0;
      const next = files[(cur + delta + files.length) % files.length];
      hunkRefs.current = [];
      bodyRef.current?.scrollTo({ top: 0 });
      useChanges.getState().openViewer(projectId, next.path);
    },
    [files, idx, projectId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        nav(-1);
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        nav(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, nav]);

  const parsed = useMemo(() => {
    if (!diff || diff.isBinary) return null;
    const p = parseUnifiedDiff(diff.text);
    annotateIntraline(p);
    return p;
  }, [diff]);

  const jumpHunk = (dir: 1 | -1) => {
    const body = bodyRef.current;
    if (!body) return;
    const tops = hunkRefs.current
      .filter((el): el is HTMLElement => el != null)
      .map((el) => el.offsetTop - body.offsetTop)
      .sort((a, b) => a - b);
    const cur = body.scrollTop;
    const alvo =
      dir === 1
        ? tops.find((t) => t > cur + 8)
        : [...tops].reverse().find((t) => t < cur - 8);
    if (alvo != null) body.scrollTo({ top: alvo, behavior: "smooth" });
  };

  const copyDiff = async () => {
    if (!diff) return;
    if (await copyText(diff.text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const reveal = () => {
    if (!root) return;
    const full = `${root}\\${file.path.replaceAll("/", "\\")}`;
    void ipc.revealPath(full).catch(() => {});
  };

  if (!project) return null;

  const setMode = useChanges.getState().setViewerMode;
  const setWhole = useChanges.getState().setViewerWhole;
  const setWrap = useChanges.getState().setViewerWrap;

  return (
    <div className="viewer-backdrop" onMouseDown={close}>
      <div
        className="viewer"
        role="dialog"
        aria-label={`Diff de ${file.path}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="viewer-header">
          <div className="viewer-title">
            <GitStatusBadge status={file.status} />
            <span className="viewer-path" data-tip={file.path}>
              <PathLabel path={file.path} bare />
            </span>
            {file.origPath && (
              <span className="viewer-orig" data-tip={file.origPath}>
                era {file.origPath}
              </span>
            )}
            <span className="viewer-chips">
              {git?.branch && (
                <span className="review-chip" data-tip="Branch atual">
                  <GitBranch size={11} />
                  {git.branch}
                </span>
              )}
              {(file.additions != null || file.deletions != null) && (
                <span className="review-chip">
                  {file.additions != null && (
                    <span className="stat-add">+{file.additions}</span>
                  )}
                  {file.deletions != null && (
                    <span className="stat-del">−{file.deletions}</span>
                  )}
                </span>
              )}
              {loading && diff && <span className="viewer-updating">atualizando…</span>}
            </span>
          </div>

          <div className="viewer-tools">
            <div className="viewer-seg" role="group" aria-label="Modo de exibição">
              <button
                className={mode === "unified" ? "is-active" : ""}
                onClick={() => setMode("unified")}
                data-tip="Visão unificada"
              >
                Unificado
              </button>
              <button
                className={mode === "split" ? "is-active" : ""}
                onClick={() => setMode("split")}
                data-tip="Antes e depois lado a lado"
              >
                Lado a lado
              </button>
            </div>
            <button
              className={`viewer-toggle ${whole ? "is-active" : ""}`}
              onClick={() => setWhole(!whole)}
              data-tip-wrap="" data-tip="Mostrar o arquivo inteiro com as mudanças marcadas, não só os trechos"
            >
              Arquivo inteiro
            </button>
            <button
              className={`icon-btn ${wrap ? "is-active" : ""}`}
              onClick={() => setWrap(!wrap)}
              data-tip="Quebra de linha"
              aria-pressed={wrap}
            >
              <WrapText size={14} />
            </button>
            <span className="viewer-sep" />
            <button
              className="icon-btn"
              onClick={() => jumpHunk(-1)}
              data-tip="Mudança anterior"
            >
              <ArrowUp size={14} />
            </button>
            <button
              className="icon-btn"
              onClick={() => jumpHunk(1)}
              data-tip="Próxima mudança"
            >
              <ArrowDown size={14} />
            </button>
            <span className="viewer-sep" />
            <button
              className="icon-btn"
              onClick={() => void copyDiff()}
              data-tip="Copiar o diff"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {file.status !== "deleted" && (
              <button
                className="icon-btn"
                onClick={reveal}
                data-tip="Mostrar no Explorer"
              >
                <FolderOpen size={14} />
              </button>
            )}
            <span className="viewer-sep" />
            <button className="icon-btn" onClick={close} data-tip-at="right" data-tip="Fechar (Esc)">
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="viewer-main">
          {files.length > 1 && (
            <FileRail
              files={files}
              current={file.path}
              onPick={(p) => {
                hunkRefs.current = [];
                bodyRef.current?.scrollTo({ top: 0 });
                useChanges.getState().openViewer(projectId, p);
              }}
            />
          )}

          <div
            className={`viewer-body ${wrap ? "viewer-body--wrap" : ""}`}
            ref={bodyRef}
          >
            {error ? (
              <div className="viewer-note viewer-note--error">{error}</div>
            ) : !diff ? (
              <div className="viewer-note">carregando diff…</div>
            ) : diff.isBinary ? (
              <div className="viewer-note">
                Arquivo binário — sem diff em texto.
              </div>
            ) : !parsed || parsed.hunks.length === 0 ? (
              <div className="viewer-note">
                Sem diferenças em relação ao último commit.
              </div>
            ) : (
              <>
                {diff.truncated && (
                  <div className="viewer-note">
                    Diff truncado — o arquivo passa do teto de leitura.
                  </div>
                )}
                {mode === "unified" ? (
                  <Unified parsed={parsed} hunkRefs={hunkRefs} />
                ) : (
                  <Split parsed={parsed} hunkRefs={hunkRefs} />
                )}
              </>
            )}
          </div>
        </div>

        <footer className="viewer-footer">
          <span>
            {files.length > 0 && idx >= 0
              ? `arquivo ${idx + 1} de ${files.length}`
              : file.path}
          </span>
          <span className="viewer-keys">
            {files.length > 1 && (
              <>
                <button className="icon-btn" onClick={() => nav(-1)} data-tip="Anterior (Alt+←)">
                  <ChevronLeft size={13} />
                </button>
                <button className="icon-btn" onClick={() => nav(1)} data-tip="Próximo (Alt+→)">
                  <ChevronRight size={13} />
                </button>
              </>
            )}
            <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> troca de arquivo ·{" "}
            <kbd>Esc</kbd> fecha
          </span>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// file rail
// ---------------------------------------------------------------------------

function FileRail({
  files,
  current,
  onPick,
}: {
  files: ChangedFile[];
  current: string;
  onPick: (path: string) => void;
}) {
  return (
    <nav className="viewer-rail" aria-label="Arquivos alterados">
      <ul>
        {files.map((f) => {
          const name = fileName(f.path);
          return (
            <li key={f.path}>
              <button
                className={`viewer-rail-row ${f.path === current ? "is-active" : ""}`}
                onClick={() => onPick(f.path)}
                data-tip-wrap="" data-tip={f.path}
              >
                <GitStatusBadge status={f.status} />
                <span className="viewer-rail-name">{name}</span>
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
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// diff renderers
// ---------------------------------------------------------------------------

type HunkRefs = MutableRefObject<(HTMLElement | null)[]>;

function Unified({ parsed, hunkRefs }: { parsed: ParsedDiff; hunkRefs: HunkRefs }) {
  return (
    <div className="dgrid dgrid--unified">
      {parsed.hunks.map((h, hi) => (
        <UnifiedHunk key={hi} hunk={h} index={hi} hunkRefs={hunkRefs} />
      ))}
    </div>
  );
}

function UnifiedHunk({
  hunk,
  index,
  hunkRefs,
}: {
  hunk: DiffHunk;
  index: number;
  hunkRefs: HunkRefs;
}) {
  return (
    <div>
      <div
        className="dline dline--hunk"
        ref={(el) => {
          hunkRefs.current[index] = el;
        }}
      >
        <span className="dnum" />
        <span className="dnum" />
        <span className="dsign" />
        <span className="dtext">{hunk.header}</span>
      </div>
      {hunk.lines.map((ln, li) => (
        <div key={li} className={`dline dline--${ln.type}`}>
          <span className="dnum">{ln.oldNo ?? ""}</span>
          <span className="dnum">{ln.newNo ?? ""}</span>
          <span className="dsign">
            {ln.type === "add" ? "+" : ln.type === "del" ? "-" : ""}
          </span>
          <span className="dtext">{emphText(ln)}</span>
        </div>
      ))}
    </div>
  );
}

function Split({ parsed, hunkRefs }: { parsed: ParsedDiff; hunkRefs: HunkRefs }) {
  return (
    <div className="dgrid dgrid--split">
      {parsed.hunks.map((h, hi) => (
        <SplitHunk key={hi} hunk={h} index={hi} hunkRefs={hunkRefs} />
      ))}
    </div>
  );
}

function SplitHunk({
  hunk,
  index,
  hunkRefs,
}: {
  hunk: DiffHunk;
  index: number;
  hunkRefs: HunkRefs;
}) {
  const rows = useMemo(() => toSplitRows(hunk), [hunk]);
  return (
    <div>
      <div
        className="dline dline--hunk"
        ref={(el) => {
          hunkRefs.current[index] = el;
        }}
      >
        <span className="dtext">{hunk.header}</span>
      </div>
      {rows.map((row, ri) => (
        <div key={ri} className="srow">
          <SplitCell line={row.left} side="del" />
          <SplitCell line={row.right} side="add" />
        </div>
      ))}
    </div>
  );
}

function SplitCell({ line, side }: { line: DiffLine | null; side: "del" | "add" }) {
  if (!line) return <div className="dcell dcell--empty" />;
  return (
    <div className={`dcell dcell--${line.type}`}>
      <span className="dnum">
        {side === "del" ? (line.oldNo ?? "") : (line.newNo ?? "")}
      </span>
      <span className="dtext">{emphText(line)}</span>
    </div>
  );
}

/** Line with the changed core marked (inline highlight). */
function emphText(ln: DiffLine): ReactNode {
  const e = ln.emph;
  if (!e) return ln.text;
  const [a, b] = e;
  return (
    <>
      {ln.text.slice(0, a)}
      <mark className="demph">{ln.text.slice(a, b)}</mark>
      {ln.text.slice(b)}
    </>
  );
}

