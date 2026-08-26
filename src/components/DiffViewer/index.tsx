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
import { ask } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import "../ChangesPanel/changes.css";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  MessageSquarePlus,
  Send,
  SquarePen,
  Trash2,
  WrapText,
  X,
} from "lucide-react";

import type { LanguageSupport } from "@codemirror/language";

import { loadSupport } from "../CodeEditor/languages";
import { chunkNodes, shineLines, sliceChunks, type ShineChunk } from "../CodeEditor/shine";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { changedFileMenu } from "../../lib/changesMenu";
import { captureTextTarget, textMenuEntries } from "../../lib/textMenu";
import { GitStatusBadge, PathLabel } from "../FileMarks";
import { Select } from "../Select";
import { injectAndConfirm } from "../../lib/inject";

import { useT } from "../../hooks/useT";
import { locale, tn } from "../../lib/i18n";

const HIGHLIGHT_MAX_BYTES = 320_000;
const HIGHLIGHT_MAX_LINES = 5_000;

function countLines(text: string): number {
  let lines = text.length === 0 ? 0 : 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  return lines;
}
import { sendability, waitUntilSendable } from "../../lib/sendable";
import { copyText } from "../../lib/clipboard";
import { anchorKey, formatReview, type ReviewComment } from "../../lib/review";
import { baseName } from "../../lib/terminals";
import { byAnchor, REVIEW_FULL, useReview } from "../../stores/reviewStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import {
  parseUnifiedDiff,
  annotateIntraline,
  toSplitRows,
  type DiffHunk,
  type DiffLine,
  type ParsedDiff,
} from "../../lib/diff";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { isTopLayer } from "../../lib/layers";
import { fileName, toOsPath } from "../../lib/paths";
import { ipc, type ChangedFile, type ChangesSummary, type FileDiff } from "../../lib/ipc";
import { fetchDiff, useChanges, type ViewerTarget } from "../../stores/changesStore";
import { useEditor } from "../../stores/editorStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

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
  const t = useT();
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
  const showToast = useUI((s) => s.showToast);

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  useDialogFocus(dialogRef, true, "viewer");

  // --- review annotations --------------------------------------------------
  const allComments = useReview((s) => s.comments);
  const [draft, setDraft] = useState<DraftAnchor | null>(null);

  // Scoped by worktree, not only by project: a floor is the same project with
  // its own copy of the file, and notes written there used to land on the
  // ground's diff (and be cleared together with it).
  const fileComments = useMemo(
    () =>
      root ? useReview.getState().ofFile(projectId, root, path) : [],
    // `allComments` is the subscription; the filtering is done by the store.
    [allComments, projectId, root, path],
  );
  const scopeComments = useMemo(
    () => (root ? useReview.getState().ofScope(projectId, root) : []),
    [allComments, projectId, root],
  );

  // Switching files closes a draft nobody would find again.
  useEffect(() => setDraft(null), [path]);

  const review = useMemo<ReviewApi>(
    () => ({
      anchors: byAnchor(fileComments),
      draft,
      open: (line, onOld, code) =>
        setDraft({ key: anchorKey(line, onOld), line, onOld, code }),
      cancel: () => setDraft(null),
      save: (body) => {
        if (!draft || !body.trim()) return setDraft(null);
        const id = useReview.getState().add({
          projectId,
          root: root ?? "",
          path,
          line: draft.line,
          onOld: draft.onOld,
          code: draft.code,
          body: body.trim(),
        });
        // The cap used to drop the *oldest* note instead, with nothing on
        // screen saying so — in a feature whose whole point is not losing what
        // you wrote.
        if (!id) showToast(t(REVIEW_FULL), "error");
        setDraft(null);
      },
      edit: (id, body) => useReview.getState().edit(id, body),
      remove: (id) => useReview.getState().remove(id),
    }),
    [fileComments, draft, projectId, root, path, showToast],
  );

  /**
   * Request generation: toggling "whole file" twice in quick succession fires
   * two `fetchDiff` calls with different cache keys, and nothing guaranteed
   * the second would answer last — the screen could end up showing the diff
   * for the option that was no longer selected.
   */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!root) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    // The old error clears at the start: before, it was only cleared on
    // success, so it stayed on screen during the next load.
    setError(null);
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
      if (seq !== loadSeq.current) return;
      setDiff(d);
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
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
      if (e.defaultPrevented) return;
      // Only the top surface handles the key: with the editor (or a modal)
      // above, one `Esc` closed both at once.
      if (!isTopLayer("viewer")) return;
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

  const diffProfile = useMemo(() => {
    if (!diff || diff.isBinary) return { lines: 0, large: false };
    const lines = countLines(diff.text);
    return {
      lines,
      large: diff.text.length > HIGHLIGHT_MAX_BYTES || lines > HIGHLIGHT_MAX_LINES,
    };
  }, [diff]);

  const parsed = useMemo(() => {
    if (!diff || diff.isBinary || diffProfile.large) return null;
    const p = parseUnifiedDiff(diff.text);
    annotateIntraline(p);
    return p;
  }, [diff, diffProfile.large]);

  // The file's grammar, the same one the editor loads: the diff shows code,
  // and code reads by its colors. Until it arrives (or when the language has
  // none) the lines render plain — the diff never waits for a grammar.
  const [support, setSupport] = useState<LanguageSupport | null>(null);
  useEffect(() => {
    let alive = true;
    setSupport(null);
    if (diffProfile.large) return;
    loadSupport(path)
      .then((s) => {
        if (alive) setSupport(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, diffProfile.large]);

  const jumpHunk = (dir: 1 | -1) => {
    const body = bodyRef.current;
    if (!body) return;
    const tops = hunkRefs.current
      .filter((el): el is HTMLElement => el != null)
      .map((el) => el.offsetTop - body.offsetTop)
      .sort((a, b) => a - b);
    const cur = body.scrollTop;
    const recipient =
      dir === 1
        ? tops.find((t) => t > cur + 8)
        : [...tops].reverse().find((t) => t < cur - 8);
    if (recipient != null) body.scrollTo({ top: recipient, behavior: "smooth" });
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
    void ipc.revealPath(toOsPath(root, file.path)).catch(() => {});
  };

  /** Reading the change and wanting to touch it is one gesture: the diff
   *  leaves, the editor comes in on the same file. */
  const editIt = () => {
    void useEditor
      .getState()
      .openFile(file.path)
      .then(close)
      .catch((e) =>
        useUI.getState().showToast(t("Não consegui abrir: {e}", { e: String(e) }), "error"),
      );
  };

  if (!project) return null;

  // Only the backend can tell: the path alone does not say whether it fell
  // inside the watched worktree.
  const external = diff?.external ?? false;

  /**
   * Right-click in the viewer: the text first (copying a piece of the diff is
   * the number one reason to come here), then what can be done with the file.
   * "Open the diff" is left out — it is already open.
   */
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const recipient = captureTextTarget(e.nativeEvent);
    const toast = useUI.getState().showToast;
    const ofFile = changedFileMenu(
      file,
      { root: root ?? null, inViewer: true },
      {
        openDiff: () => {},
        openInEditor: (p) => {
          void useEditor
            .getState()
            .openFile(p)
            .catch((err) => toast(t("Não consegui abrir: {e}", { e: String(err) }), "error"));
        },
        copyPath: (theText) => {
          void copyText(theText).then((ok) =>
            toast(ok ? t("Caminho copiado.") : t("Não consegui copiar."), ok ? "info" : "error"),
          );
        },
        reveal: (osPath) => {
          void ipc.revealPath(osPath).catch((err) => toast(String(err), "error"));
        },
        refresh: () => {},
        clearFeed: () => {},
        close,
      },
    );
    const text = textMenuEntries(recipient, { app: false });
    setMenu({
      anchor: { x: e.clientX, y: e.clientY },
      entries: text.length > 0 ? [...text, { kind: "sep" }, ...ofFile] : ofFile,
    });
  };

  const setMode = useChanges.getState().setViewerMode;
  const setWhole = useChanges.getState().setViewerWhole;
  const setWrap = useChanges.getState().setViewerWrap;

  return (
    // Only the primary button closes: with the right one the gesture is "open the menu".
    <div className="viewer-backdrop" onMouseDown={(e) => e.button === 0 && close()}>
      <div
        ref={dialogRef}
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-label={t("Diff de {path}", { path: file.path })}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={openMenu}
      >
        {menu && (
          <ContextMenu
            anchor={menu.anchor}
            items={menu.entries}
            onClose={() => setMenu(null)}
          />
        )}
        <header className="viewer-header">
          <div className="viewer-title">
            {!external && <GitStatusBadge status={file.status} />}
            <span className="viewer-path" data-tip={file.path}>
              <PathLabel path={file.path} bare />
            </span>
            {file.origPath && (
              <span className="viewer-orig" data-tip={file.origPath}>
                era {file.origPath}
              </span>
            )}
            <span className="viewer-chips">
              {external && (
                <span
                  className="review-chip"
                  data-tip-wrap=""
                  data-tip={t("O agente tocou este arquivo, mas ele não está no repositório — não há com o que comparar")}
                >
                  {t("fora do repositório")}
                </span>
              )}
              {!external && git?.branch && (
                <span className="review-chip" data-tip={t("Branch atual")}>
                  <GitBranch size={11} aria-hidden="true" />
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
            <div className="viewer-seg" role="group" aria-label={t("Modo de exibição")}>
              <button
                className={mode === "unified" ? "is-active" : ""}
                onClick={() => setMode("unified")}
                data-tip={t("Visão unificada")}
              >
                {t("Unificado")}
              </button>
              <button
                className={mode === "split" ? "is-active" : ""}
                onClick={() => setMode("split")}
                data-tip={t("Antes e depois lado a lado")}
              >
                {t("Lado a lado")}
              </button>
            </div>
            {/* Outside the repository it already IS the whole file. */}
            {!external && (
              <button
                className={`viewer-toggle ${whole ? "is-active" : ""}`}
                onClick={() => setWhole(!whole)}
                data-tip-wrap="" data-tip={t("Mostrar o arquivo inteiro com as mudanças marcadas, não só os trechos")}
              >
                {t("Arquivo inteiro")}
              </button>
            )}
            <button
              className={`icon-btn ${wrap ? "is-active" : ""}`}
              onClick={() => setWrap(!wrap)}
              data-tip={t("Quebra de linha")}
              aria-label={t("Quebra de linha")}
              aria-pressed={wrap}
            >
              <WrapText size={14} />
            </button>
            <span className="viewer-sep" />
            <button
              className="icon-btn"
              onClick={() => jumpHunk(-1)}
              data-tip={t("Mudança anterior")}
              aria-label={t("Ir para a mudança anterior")}
            >
              <ArrowUp size={14} />
            </button>
            <button
              className="icon-btn"
              onClick={() => jumpHunk(1)}
              data-tip={t("Próxima mudança")}
              aria-label={t("Ir para a próxima mudança")}
            >
              <ArrowDown size={14} />
            </button>
            <span className="viewer-sep" />
            <button
              className="icon-btn"
              onClick={() => review.open(null, false, "")}
              data-tip-wrap=""
              data-tip={t("Anotar o arquivo inteiro (nas linhas, use o + que aparece ao passar o mouse)")}
              aria-label={t("Anotar este arquivo")}
            >
              <MessageSquarePlus size={14} />
            </button>
            <button
              className="icon-btn"
              onClick={() => void copyDiff()}
              data-tip={t("Copiar o diff")}
              aria-label={t("Copiar o diff")}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {file.status !== "deleted" && (
              <>
                {/* The editor only opens what lives inside the project root. */}
                {!external && (
                  <button
                    className="icon-btn"
                    onClick={editIt}
                    data-tip={t("Abrir no editor")}
                    aria-label={t("Abrir este arquivo no editor")}
                  >
                    <SquarePen size={14} />
                  </button>
                )}
                <button
                  className="icon-btn"
                  onClick={reveal}
                  data-tip={t("Mostrar no Explorer")}
                  aria-label={t("Mostrar este arquivo no Explorer")}
                >
                  <FolderOpen size={14} />
                </button>
              </>
            )}
            <span className="viewer-sep" />
            <button
              className="icon-btn"
              onClick={close}
              data-tip-at="right"
              data-tip={t("Fechar (Esc)")}
              aria-label={t("Fechar o visualizador")}
            >
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
              <div className="viewer-note">{t("carregando diff…")}</div>
            ) : diff.isBinary ? (
              <div className="viewer-note">
                {t("Arquivo binário — sem diff em texto.")}
              </div>
            ) : diffProfile.large ? (
              <>
                {external && (
                  <div className="viewer-note">
                    {t("Fora do repositório — conteúdo atual do arquivo, sem comparação.")}
                  </div>
                )}
                {diff.truncated && (
                  <div className="viewer-note">
                    {external
                      ? t("Arquivo truncado — passa do teto de leitura.")
                      : t("Diff truncado — o arquivo passa do teto de leitura.")}
                  </div>
                )}
                <div className="viewer-note">
                  {t(
                    "Diff grande ({n} linhas) — exibido como texto contínuo para limitar o DOM; realce, comparação intralinha e comentários por linha ficam suspensos.",
                    { n: diffProfile.lines.toLocaleString(locale()) },
                  )}
                </div>
                <pre className="diff-large-raw">{diff.text}</pre>
              </>
            ) : !parsed || parsed.hunks.length === 0 ? (
              <div className="viewer-note">
                {external
                  ? t("Arquivo vazio.")
                  : t("Sem diferenças em relação ao último commit.")}
              </div>
            ) : (
              <>
                {external && (
                  <div className="viewer-note">
                    {t("Fora do repositório — conteúdo atual do arquivo, sem comparação.")}
                  </div>
                )}
                {diff.truncated && (
                  <div className="viewer-note">
                    {external
                      ? t("Arquivo truncado — passa do teto de leitura.")
                      : t("Diff truncado — o arquivo passa do teto de leitura.")}
                  </div>
                )}
                {mode === "unified" ? (
                  <Unified
                    parsed={parsed}
                    hunkRefs={hunkRefs}
                    review={review}
                    support={support}
                  />
                ) : (
                  <Split
                    parsed={parsed}
                    hunkRefs={hunkRefs}
                    review={review}
                    support={support}
                  />
                )}
              </>
            )}
            {/* The whole-file comment has no line to sit under. */}
            {(review.anchors.get("file")?.length || review.draft?.key === "file") && (
              <div className="dnotes dnotes--file">
                {(review.anchors.get("file") ?? []).map((c) => (
                  <ReviewCard key={c.id} comment={c} review={review} />
                ))}
                {review.draft?.key === "file" && <ReviewDraft review={review} />}
              </div>
            )}
          </div>
        </div>

        {scopeComments.length > 0 && (
          <ReviewBar
            comments={scopeComments}
            projectId={projectId}
            root={root ?? ""}
            projectName={project.name}
            branch={git?.branch ?? null}
            currentPath={path}
          />
        )}

        <footer className="viewer-footer">
          <span>
            {files.length > 0 && idx >= 0
              ? t("arquivo {i} de {n}", { i: idx + 1, n: files.length })
              : file.path}
          </span>
          <span className="viewer-keys">
            {files.length > 1 && (
              <>
                <button
                  className="icon-btn"
                  onClick={() => nav(-1)}
                  data-tip={t("Anterior (Alt+←)")}
                  aria-label={t("Arquivo anterior")}
                >
                  <ChevronLeft size={13} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => nav(1)}
                  data-tip={t("Próximo (Alt+→)")}
                  aria-label={t("Próximo arquivo")}
                >
                  <ChevronRight size={13} />
                </button>
              </>
            )}
            <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> {t("troca de arquivo")} ·{" "}
            <kbd>Esc</kbd> {t("fecha")}
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
  const t = useT();
  return (
    <nav className="viewer-rail" aria-label={t("Arquivos alterados")}>
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

/**
 * Syntax colors for one hunk, keyed by its line objects.
 *
 * Each side is reassembled as contiguous text and parsed **whole** — a block
 * comment opened three lines above the change still colors as a comment,
 * which per-line parsing would lose. The old side owns the deletions, the new
 * side owns additions and context; a `note` line ("\ No newline…") is git
 * talking, not code, and stays out of both.
 */
function shineHunk(
  hunk: DiffHunk,
  support: LanguageSupport,
): Map<DiffLine, ShineChunk[]> {
  const map = new Map<DiffLine, ShineChunk[]>();
  const olds = hunk.lines.filter((l) => l.type === "del" || l.type === "ctx");
  const news = hunk.lines.filter((l) => l.type === "add" || l.type === "ctx");
  const oldShine = shineLines(olds.map((l) => l.text).join("\n"), support);
  olds.forEach((l, i) => {
    if (l.type === "del") map.set(l, oldShine[i] ?? []);
  });
  const newShine = shineLines(news.map((l) => l.text).join("\n"), support);
  news.forEach((l, i) => map.set(l, newShine[i] ?? []));
  return map;
}

type ShineMap = Map<DiffLine, ShineChunk[]> | null;

const useShineMap = (hunk: DiffHunk, support: LanguageSupport | null): ShineMap =>
  useMemo(() => (support ? shineHunk(hunk, support) : null), [hunk, support]);

function Unified({
  parsed,
  hunkRefs,
  review,
  support,
}: {
  parsed: ParsedDiff;
  hunkRefs: HunkRefs;
  review: ReviewApi;
  support: LanguageSupport | null;
}) {
  return (
    <div className="dgrid dgrid--unified">
      {parsed.hunks.map((h, hi) => (
        <UnifiedHunk
          key={hi}
          hunk={h}
          index={hi}
          hunkRefs={hunkRefs}
          review={review}
          support={support}
        />
      ))}
    </div>
  );
}

function UnifiedHunk({
  hunk,
  index,
  hunkRefs,
  review,
  support,
}: {
  hunk: DiffHunk;
  index: number;
  hunkRefs: HunkRefs;
  review: ReviewApi;
  support: LanguageSupport | null;
}) {
  const shine = useShineMap(hunk, support);
  return (
    <div className="diff-hunk">
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
      {hunk.lines.map((ln, li) => {
        const at = lineAnchor(ln);
        return (
          <LineSlot key={li} review={review} keys={anchorKeys(ln)}>
            <div className={`dline dline--${ln.type}`}>
              <NoteButton review={review} line={at.line} onOld={at.onOld} code={ln.text} />
              <span className="dnum">{ln.oldNo ?? ""}</span>
              <span className="dnum">{ln.newNo ?? ""}</span>
              <span className="dsign">
                {ln.type === "add" ? "+" : ln.type === "del" ? "-" : ""}
              </span>
              <span className="dtext">{lineText(ln, shine?.get(ln))}</span>
            </div>
          </LineSlot>
        );
      })}
    </div>
  );
}

function Split({
  parsed,
  hunkRefs,
  review,
  support,
}: {
  parsed: ParsedDiff;
  hunkRefs: HunkRefs;
  review: ReviewApi;
  support: LanguageSupport | null;
}) {
  return (
    <div className="dgrid dgrid--split">
      {parsed.hunks.map((h, hi) => (
        <SplitHunk
          key={hi}
          hunk={h}
          index={hi}
          hunkRefs={hunkRefs}
          review={review}
          support={support}
        />
      ))}
    </div>
  );
}

function SplitHunk({
  hunk,
  index,
  hunkRefs,
  review,
  support,
}: {
  hunk: DiffHunk;
  index: number;
  hunkRefs: HunkRefs;
  review: ReviewApi;
  support: LanguageSupport | null;
}) {
  const rows = useMemo(() => toSplitRows(hunk), [hunk]);
  const shine = useShineMap(hunk, support);
  return (
    <div className="diff-hunk">
      <div
        className="dline dline--hunk"
        ref={(el) => {
          hunkRefs.current[index] = el;
        }}
      >
        <span className="dtext">{hunk.header}</span>
      </div>
      {rows.map((row, ri) => {
        // Both sides of the row hang their notes under it: side by side there
        // is no room for a card inside a column. A context row is the *same*
        // line on both sides, so the keys are deduped — otherwise its comment
        // would be painted twice.
        const keys = [
          ...new Set([...anchorKeys(row.left), ...anchorKeys(row.right)]),
        ];
        return (
          <LineSlot key={ri} review={review} keys={keys}>
            <div className="srow">
              <SplitCell
                line={row.left}
                side="del"
                review={review}
                chunks={row.left ? shine?.get(row.left) : undefined}
              />
              <SplitCell
                line={row.right}
                side="add"
                review={review}
                chunks={row.right ? shine?.get(row.right) : undefined}
              />
            </div>
          </LineSlot>
        );
      })}
    </div>
  );
}

function SplitCell({
  line,
  side,
  review,
  chunks,
}: {
  line: DiffLine | null;
  side: "del" | "add";
  review: ReviewApi;
  chunks?: ShineChunk[];
}) {
  if (!line) return <div className="dcell dcell--empty" />;
  const at = lineAnchor(line);
  // Only the column the anchor belongs to offers the `+`. A context line
  // shows on both sides, and two buttons for one comment is one too many.
  const mine = side === "del" ? at.onOld : !at.onOld;
  return (
    <div className={`dcell dcell--${line.type}`}>
      {mine && (
        <NoteButton review={review} line={at.line} onOld={at.onOld} code={line.text} />
      )}
      <span className="dnum">{(side === "del" ? line.oldNo : line.newNo) ?? ""}</span>
      <span className="dtext">{lineText(line, chunks)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// review annotations
// ---------------------------------------------------------------------------

/**
 * Where a comment on this line goes: a deletion belongs to the old side,
 * everything else (added, context) to the new one.
 *
 * `line: null` means the row has no number to point at — the
 * "\ No newline at end of file" marker. Those must not fall back to the
 * file-level anchor, or every file comment would be painted under them.
 */
function lineAnchor(line: DiffLine): { line: number | null; onOld: boolean } {
  const onOld = line.type === "del";
  return { line: onOld ? line.oldNo : line.newNo, onOld };
}

/** The anchor keys a row answers for — empty when it cannot be annotated. */
function anchorKeys(line: DiffLine | null): string[] {
  if (!line) return [];
  const at = lineAnchor(line);
  return at.line == null ? [] : [anchorKey(at.line, at.onOld)];
}

/** Where a comment being written is anchored. */
interface DraftAnchor {
  key: string;
  line: number | null;
  onOld: boolean;
  code: string;
}

/**
 * Everything the diff rows need in order to show and take annotations.
 *
 * One object rather than six props: it crosses three components to reach a
 * line, and a prop list that long is how a renderer stops being readable.
 */
interface ReviewApi {
  anchors: Map<string, ReviewComment[]>;
  draft: DraftAnchor | null;
  open: (line: number | null, onOld: boolean, code: string) => void;
  cancel: () => void;
  save: (body: string) => void;
  edit: (id: string, body: string) => void;
  remove: (id: string) => void;
}

/** The `+` that appears in the gutter on hover. */
function NoteButton({
  review,
  line,
  onOld,
  code,
}: {
  review: ReviewApi;
  line: number | null;
  onOld: boolean;
  code: string;
}) {
  const t = useT();
  if (line == null) return null;
  return (
    <button
      className="dnote-add"
      aria-label={t("Anotar a linha {line}", { line })}
      data-tip={t("Anotar esta linha")}
      onClick={() => review.open(line, onOld, code)}
    >
      <MessageSquarePlus size={11} />
    </button>
  );
}

/** A diff line plus whatever is written about it, underneath. */
function LineSlot({
  review,
  keys,
  children,
}: {
  review: ReviewApi;
  keys: string[];
  children: ReactNode;
}) {
  const cards = keys.flatMap((k) => review.anchors.get(k) ?? []);
  const drafting = review.draft && keys.includes(review.draft.key);
  if (cards.length === 0 && !drafting) return <>{children}</>;
  return (
    <>
      {children}
      <div className="dnotes">
        {cards.map((c) => (
          <ReviewCard key={c.id} comment={c} review={review} />
        ))}
        {drafting && <ReviewDraft review={review} />}
      </div>
    </>
  );
}

function ReviewCard({
  comment,
  review,
}: {
  comment: ReviewComment;
  review: ReviewApi;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);

  if (editing) {
    return (
      <ReviewDraft
        review={review}
        initial={text}
        onCommit={(body) => {
          review.edit(comment.id, body);
          setEditing(false);
        }}
        onCancel={() => {
          setText(comment.body);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="dnote">
      <p className="dnote-body">{comment.body}</p>
      <div className="dnote-tools">
        <button
          className="icon-btn"
          data-tip={t("Editar")}
          aria-label={t("Editar esta anotação")}
          onClick={() => setEditing(true)}
        >
          <SquarePen size={12} />
        </button>
        <button
          className="icon-btn"
          data-tip={t("Apagar")}
          aria-label={t("Apagar esta anotação")}
          onClick={() => review.remove(comment.id)}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * The box for writing. `Ctrl+Enter` saves and `Esc` cancels — the same pair
 * as the prompt composer, because it is the same gesture.
 */
function ReviewDraft({
  review,
  initial = "",
  onCommit,
  onCancel,
}: {
  review: ReviewApi;
  initial?: string;
  onCommit?: (body: string) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
    areaRef.current?.setSelectionRange(text.length, text.length);
    // Focus on mount only: re-running on every keystroke would fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = () => (onCommit ? onCommit(text) : review.save(text));
  const cancel = () => (onCancel ? onCancel() : review.cancel());

  return (
    <div className="dnote dnote--draft">
      <textarea
        ref={areaRef}
        className="dnote-input"
        rows={2}
        spellCheck={false}
        value={text}
        placeholder={t("O que precisa mudar aqui?")}
        aria-label={t("Texto da anotação")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
      />
      <div className="dnote-foot">
        <span className="dnote-hint">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {t("guarda")} · <kbd>Esc</kbd> {t("cancela")}
        </span>
        <button className="btn btn--ghost" onClick={cancel}>
          {t("Cancelar")}
        </button>
        <button className="btn btn--primary" disabled={!text.trim()} onClick={commit}>
          {t("Guardar")}
        </button>
      </div>
    </div>
  );
}

/**
 * The bar that turns a review into a message.
 *
 * It counts the whole project, not the open file: the point is to write four
 * comments across three files and send **one** thing.
 */
function ReviewBar({
  comments,
  projectId,
  root,
  projectName,
  branch,
  currentPath,
}: {
  comments: ReviewComment[];
  projectId: string;
  /** Worktree being reviewed — sending and clearing stop at its border. */
  root: string;
  projectName: string;
  branch: string | null;
  currentPath: string;
}) {
  const t = useT();
  const terminals = useProjects((s) => s.terminals);
  const groups = useProjects((s) => s.groups);
  const runtimes = useTerminals((s) => s.byId);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const showToast = useUI((s) => s.showToast);
  const [target, setTarget] = useState("");
  const [sending, setSending] = useState(false);

  // Only what is alive can receive: injecting into a dead PTY loses the text
  // silently, which for a review means losing the work twice.
  //
  // And only what belongs to **this project**: the list used to be every live
  // terminal in the workspace, so opening the viewer without having clicked a
  // terminal first pre-selected the first CLI of whatever project happened to
  // sort first — and Enviar handed the review of one repo to an agent working
  // in another, wiping the annotations just the same.
  const options = useMemo(() => {
    const ofProject = new Set(
      groups.filter((g) => g.projectId === projectId).map((g) => g.id),
    );
    const byGroup = new Map(groups.map((g) => [g.id, g]));
    return terminals
      .filter((t) => ofProject.has(t.groupId) && isLive(runtimes[t.id]))
      .map((t) => ({
        value: t.id,
        label: baseName(t),
        group: byGroup.get(t.groupId)?.name,
      }));
  }, [terminals, groups, runtimes, projectId]);

  const chosen =
    options.find((o) => o.value === target)?.value ??
    options.find((o) => o.value === focusedTerminalId)?.value ??
    options[0]?.value ??
    "";

  const others = comments.filter((c) => c.path !== currentPath).length;

  /**
   * The send is the one gesture in the app that destroys work on success:
   * `clearScope` erases every annotation written against this worktree, up to
   * the `reviewStore` cap. So both halves have to hold before it runs.
   *
   * 1. The agent has to be *able* to read a prompt. Alive is not enough —
   *    `injectPrompt` ends with Enter, so a CLI frozen on `(y/N)` would take
   *    the review as its answer, approve whatever was being asked, and the
   *    annotations would be gone for a message nobody ever read.
   * 2. The text has to have actually landed. A write that resolves only means
   *    the ConPTY accepted the bytes; `injectAndConfirm` waits for the echo.
   *
   * When the second one is inconclusive the annotations stay. Sending twice
   * is an annoyance; losing a multi-file review is the thing this whole
   * feature exists to prevent.
   */
  const sendIt = async () => {
    if (!chosen || sending) return;
    const itemName = options.find((o) => o.value === chosen)?.label ?? t("o agente");

    const ready = sendability(chosen);
    if (!ready.ok && ready.reason !== "busy") {
      showToast(
        ready.message ?? t("{name} não pode receber a revisão agora.", { name: itemName }),
        "error",
      );
      return;
    }

    setSending(true);
    try {
      if (!ready.ok) {
        showToast(t("Esperando {name} ficar livre para receber a revisão…", { name: itemName }));
        const after = await waitUntilSendable(chosen);
        if (!after.ok) {
          showToast(
            `${after.message ?? t("{name} continua ocupado.", { name: itemName })} ${t("As anotações continuam aqui.")}`, // i18n-ok
            "error",
          );
          return;
        }
      }

      const text = formatReview(comments, { projectName, branch });
      const delivered = await injectAndConfirm(chosen, text);
      if (!delivered) {
        showToast(
          t(
            "Enviei para {name}, mas ele não deu sinal de ter recebido. Confira a CLI — guardei as anotações para você não perdê-las.",
            { name: itemName },
          ),
          "error",
        );
        return;
      }
      // The send is the one action in the app that destroys work when it
      // succeeds: the annotations vanish and what is left is the message in
      // the agent's scrollback. A copy on the clipboard costs nothing and
      // buys back the rescue.
      const copied = await copyText(text);
      // Only the ones that went in the text: the confirmation takes a few
      // seconds, and a note written in the meantime was not in the message —
      // deleting it would lose work nobody sent.
      useReview.getState().removeMany(comments.map((c) => c.id));
      showToast(
        tn(comments.length, "{n} anotação enviada para {name}.", "{n} anotações enviadas para {name}.", {
          name: itemName,
        }) + (copied ? ` ${t("Uma cópia ficou na área de transferência.")}` : ""), // i18n-ok
      );
    } catch (e) {
      showToast(t("Falha ao enviar a revisão: {e}", { e: String(e) }), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="viewer-review">
      <span className="viewer-review-count">
        {tn(comments.length, "{n} anotação", "{n} anotações")}
        {others > 0 && (
          <span className="viewer-review-elsewhere">
            {" "}
            {t("({n} em outros arquivos)", { n: others })}
          </span>
        )}
      </span>
      <button
        className="btn btn--ghost"
        disabled={comments.length === 0 && others === 0}
        // The label said "Limpar" next to a count of *this file*, and wiped
        // the whole project's review — one tab stop away from "Enviar".
        aria-label={t("Apagar as {n} anotações desta revisão", { n: comments.length + others })}
        onClick={() => {
          const total = comments.length + others;
          void ask(
            others > 0
              ? t(
                  "Apagar as {total} anotações desta revisão? {others} está(ão) em outros arquivos, fora do que você vê aqui.",
                  { total, others },
                )
              : t("Apagar as {total} anotações desta revisão?", { total }),
            { title: t("Limpar revisão"), kind: "warning" },
          ).then((ok) => {
            if (ok) useReview.getState().clearScope(projectId, root);
          });
        }}
      >
        {t("Limpar tudo")}
      </button>
      {options.length === 0 ? (
        <span className="viewer-review-empty">
          {t("Nenhum agente rodando para receber a revisão.")}
        </span>
      ) : (
        <>
          <Select
            className="viewer-review-target"
            value={chosen}
            options={options}
            onChange={setTarget}
            label={t("Agente que recebe a revisão")}
          />
          <button
            className="btn btn--primary"
            disabled={sending}
            onClick={() => void sendIt()}
          >
            <Send size={13} /> {t("Enviar")}
          </button>
        </>
      )}
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

/**
 * The line as shown: syntax colors when the grammar has arrived, the plain
 * `emphText` until then. With both at once the chunks are cut *at* the emph
 * boundaries, so the `<mark>` composes with the coloring instead of one
 * painting over the other.
 */
function lineText(ln: DiffLine, chunks?: ShineChunk[]): ReactNode {
  if (!chunks) return emphText(ln);
  if (!ln.emph) return chunkNodes(chunks);
  const [a, b] = ln.emph;
  return (
    <>
      {chunkNodes(sliceChunks(chunks, 0, a))}
      <mark className="demph">{chunkNodes(sliceChunks(chunks, a, b))}</mark>
      {chunkNodes(sliceChunks(chunks, b, Infinity))}
    </>
  );
}

