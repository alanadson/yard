/**
 * A comparison as a tab — the diff of one file **beside the CLIs**, the way
 * VS Code's diff editor opens from source control.
 *
 * It is the review viewer's own renderer (`Unified`/`Split`, without the
 * annotations) inside the editor's chrome: the path as the title with the
 * file's menu behind it, the comparison named right after it, and on the
 * right only how to look at it. What makes it a *tab* and not a snapshot is
 * that it follows the repository: a working-tree or index comparison re-reads
 * itself every time the Source Control tab writes (`ScmRepo.version`) and
 * every time a new `git status` lands — the agent keeps editing, the diff
 * keeps up. A commit's diff is history and is read once.
 *
 * The document itself (`OpenDoc.diff`) is the store's; this file only draws
 * it. It keeps no state the tab bar or the next boot would need.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, SquarePen, WrapText } from "lucide-react";
import type { LanguageSupport } from "@codemirror/language";

import "../ChangesPanel/changes.css";
import { ContextMenu, type MenuAnchor } from "../ContextMenu";
import { Split, Unified, diffProfileOf, type HunkRefs } from "../DiffViewer";
import { fileMenu } from "./chrome";
import { useT } from "../../hooks/useT";
import { loadSupport } from "./languages";
import { docTabMenu } from "../../lib/editorActions";
import { t, tn, locale } from "../../lib/i18n";
import { annotateIntraline, parseUnifiedDiff, type ParsedDiff } from "../../lib/diff";
import { diffSuffix, type DiffSpec } from "../../lib/diffTab";
import { ipc, type FileDiff } from "../../lib/ipc";
import { splitOsPath, toOsPath } from "../../lib/paths";
import { sameRoot } from "../../lib/roots";
import { unifiedDiff } from "../../lib/unified";
import { WHOLE_FILE_CONTEXT, useChanges } from "../../stores/changesStore";
import { useEditor, type OpenDoc } from "../../stores/editorStore";
import { useScm } from "../../stores/scmStore";
import { useUI } from "../../stores/uiStore";

/** A document that is a comparison — the narrowing the hosts need to pick this surface. */
export type ComparisonDoc = OpenDoc & { diff: DiffSpec };

export const isComparison = (d: OpenDoc): d is ComparisonDoc => !!d.diff;

/** What each comparison is, in one sentence — the chip's tooltip. */
function explain(spec: DiffSpec): string {
  if (spec.source === "commit") return t("O que este commit fez neste arquivo");
  if (spec.source === "draft") {
    return t("O rascunho comparado com o disco: o que o Ctrl+S vai gravar");
  }
  switch (spec.side) {
    case "worktree":
      return t("O que mudou no disco e ainda não foi preparado (índice → disco)");
    case "index":
      return t("O que está preparado para o próximo commit (HEAD → índice)");
    case "head":
      return t("O disco comparado com o último commit (HEAD → disco)");
  }
}

/** What the tab says when the comparison comes back empty. */
function nothingHere(spec: DiffSpec): string {
  if (spec.source === "commit") return t("Este commit não mudou o texto deste arquivo.");
  if (spec.source === "draft") return t("O que está aqui é o que está no disco.");
  return spec.side === "index"
    ? t("Nada preparado neste arquivo agora — a aba acompanha o repositório e mostra o diff quando algo for preparado.")
    : t("Nada mexido neste arquivo agora — a aba acompanha o repositório e mostra o diff quando o arquivo mudar.");
}

function countChanges(parsed: ParsedDiff | null): { add: number; del: number } | null {
  if (!parsed) return null;
  let add = 0;
  let del = 0;
  for (const h of parsed.hunks) {
    for (const l of h.lines) {
      if (l.type === "add") add += 1;
      else if (l.type === "del") del += 1;
    }
  }
  return { add, del };
}

export function DiffTab({ doc }: { doc: ComparisonDoc }) {
  const t = useT();
  const spec = doc.diff;
  const live = spec.source === "tree";

  // How to look at it is shared with the review viewer on purpose: whoever
  // reads side by side reads side by side everywhere.
  const mode = useChanges((s) => s.viewerMode);
  const wrap = useChanges((s) => s.viewerWrap);
  const whole = useChanges((s) => s.viewerWhole);
  // The two things that tell a live comparison to re-read itself: a write
  // made from the Source Control tab, and a fresh `git status` (the agent's
  // edits). A commit's diff listens to neither.
  const version = useScm((s) => (live ? s.repoOf(doc.root).version : 0));
  const git = useChanges((s) => (live && doc.projectId ? s.gitByProject[doc.projectId] : undefined));
  const showToast = useUI((s) => s.showToast);
  /**
   * A draft comparison follows the buffer the way a live one follows the
   * repository: it is about text that is being typed right now. Deferred, so
   * the diff is rebuilt when the typing pauses and not on every key.
   */
  const draftText = useEditor((s) =>
    spec.source === "draft"
      ? (s.docs.find((d) => sameRoot(d.root, doc.root) && d.path === doc.path && !d.diff)
          ?.text ?? "")
      : "",
  );
  const draft = useDeferredValue(draftText);

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const hunkRefs: HunkRefs = useRef([]);
  /** Request generation — the last ask is the one whose answer counts. */
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    // The draft comparison has no backend: both texts are already open in
    // this window, and asking git about a file it has not seen written yet
    // would answer about the disk, which is the side being compared *to*.
    if (spec.source === "draft") {
      const source = useEditor
        .getState()
        .docs.find((d) => sameRoot(d.root, doc.root) && d.path === doc.path && !d.diff);
      const text = source ? unifiedDiff(source.saved, source.text, doc.path) : null;
      setDiff(
        source
          ? {
              path: doc.path,
              isBinary: false,
              truncated: false,
              external: false,
              text: text ?? "",
            }
          : null,
      );
      setError(
        source
          ? text === null
            ? t("O rascunho e o disco estão longe demais para comparar.")
            : null
          : t("O arquivo não está mais aberto."),
      );
      setLoading(false);
      return;
    }
    const ask =
      spec.source === "commit"
        ? ipc.scmCommitFileDiff(doc.root, spec.hash, doc.path)
        : ipc.scmDiff(doc.root, doc.path, spec.side, spec.origPath, whole ? WHOLE_FILE_CONTEXT : null);
    void ask
      .then((d) => {
        if (mine !== seq.current) return;
        setDiff(d);
        setError(null);
      })
      .catch((e) => {
        if (mine === seq.current) setError(String(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    // `git` is the subscription, not a value read here: a new summary means a
    // new comparison, and that is the whole reason the tab stays alive.
  }, [doc.root, doc.path, spec, whole, version, git, draft]);

  const profile = useMemo(() => diffProfileOf(diff), [diff]);
  const parsed = useMemo(() => {
    if (!diff || diff.isBinary || profile.large) return null;
    const p = parseUnifiedDiff(diff.text);
    annotateIntraline(p);
    return p;
  }, [diff, profile.large]);
  const stats = useMemo(() => countChanges(parsed), [parsed]);

  // The file's grammar, like the editor and the viewer: the diff never waits
  // for it, and a language with none just stays plain.
  const [support, setSupport] = useState<LanguageSupport | null>(null);
  useEffect(() => {
    let alive = true;
    setSupport(null);
    if (profile.large) return;
    loadSupport(doc.path)
      .then((s) => {
        if (alive) setSupport(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [doc.path, profile.large]);

  const osPath = toOsPath(doc.root, doc.path);
  const crumb = splitOsPath(osPath);
  const setMode = useChanges.getState().setViewerMode;
  const setWhole = useChanges.getState().setViewerWhole;
  const setWrap = useChanges.getState().setViewerWrap;

  /** Reading the change and wanting to touch it is one gesture. */
  const editIt = () => {
    void useEditor
      .getState()
      .openFile(doc.path)
      .catch((e) => showToast(t("Não consegui abrir: {e}", { e }), "error"));
  };

  const menuEntries = () =>
    fileMenu(
      docTabMenu(doc, useEditor.getState().docs),
      { wrap, media: false, dirty: false, git: false, eolCrlf: false, encoding: "utf-8" },
      {
        toggleWrap: () => setWrap(!wrap),
        openExternal: () => {},
        compareHead: () => {},
        compareSaved: () => {},
        setEol: () => {},
        reopenWith: () => {},
      },
    );

  let body: React.ReactNode;
  if (error) {
    body = <div className="viewer-note viewer-note--error">{error}</div>;
  } else if (!diff) {
    body = <div className="viewer-note">{t("Lendo o diff…")}</div>;
  } else if (diff.isBinary) {
    body = <div className="viewer-note">{t("Arquivo binário — sem diff de texto.")}</div>;
  } else if (profile.large) {
    body = (
      <>
        {diff.truncated && (
          <div className="viewer-note">{t("Diff truncado — o arquivo passa do teto de leitura.")}</div>
        )}
        <div className="viewer-note">
          {t(
            "Diff grande ({n} linhas) — exibido como texto contínuo para limitar o DOM; realce e comparação intralinha ficam suspensos.",
            { n: profile.lines.toLocaleString(locale()) },
          )}
        </div>
        <pre className="diff-large-raw">{diff.text}</pre>
      </>
    );
  } else if (!parsed || parsed.hunks.length === 0) {
    body = <div className="viewer-note">{nothingHere(spec)}</div>;
  } else {
    body =
      mode === "split" ? (
        <Split parsed={parsed} hunkRefs={hunkRefs} review={null} support={support} />
      ) : (
        <Unified parsed={parsed} hunkRefs={hunkRefs} review={null} support={support} />
      );
  }

  return (
    <div className="editor-body dtab">
      {/* The same header as a file's: the path is the title and the file's
          menu hangs from it. What is different is said right after the name —
          which comparison this is — and the tools on the right are the
          viewer's, not the text's. */}
      <div className="editor-pathbar">
        <button
          className={`editor-crumb ${menu ? "is-open" : ""}`}
          data-tip-wrap=""
          data-tip={osPath}
          aria-label={t("{path} — ações do arquivo", { path: osPath })}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <span className="editor-crumb-path">
            {crumb.dir && (
              <span className="editor-crumb-dir">
                <span className="editor-crumb-ltr">{crumb.dir}</span>
              </span>
            )}
            <span className="editor-crumb-base">{crumb.base}</span>
          </span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
        <span className="editor-chip dtab-which" data-tip-wrap="" data-tip={explain(spec)}>
          {diffSuffix(spec)}
        </span>
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span
            className="dtab-stat"
            aria-label={t("{add} linhas adicionadas, {del} removidas", { add: stats.add, del: stats.del })}
          >
            <span className="stat-add">+{stats.add}</span>
            <span className="stat-del">−{stats.del}</span>
          </span>
        )}
        {loading && diff && <span className="viewer-updating">{t("atualizando…")}</span>}

        <div className="editor-tools">
          <div className="viewer-seg" role="group" aria-label={t("Modo de exibição")}>
            <button
              className={mode === "unified" ? "is-active" : ""}
              aria-pressed={mode === "unified"}
              onClick={() => setMode("unified")}
              data-tip={t("Visão unificada")}
            >
              {t("Unificado")}
            </button>
            <button
              className={mode === "split" ? "is-active" : ""}
              aria-pressed={mode === "split"}
              onClick={() => setMode("split")}
              data-tip={t("Antes e depois lado a lado")}
            >
              {t("Lado a lado")}
            </button>
          </div>
          {/* A commit's diff has no "whole file" to ask git for. */}
          {live && (
            <button
              className={`viewer-toggle ${whole ? "is-active" : ""}`}
              aria-pressed={whole}
              onClick={() => setWhole(!whole)}
              data-tip={t("Ver a mudança no meio do arquivo inteiro")}
            >
              {t("Arquivo inteiro")}
            </button>
          )}
          <button
            className={`icon-btn ${wrap ? "is-active" : ""}`}
            aria-pressed={wrap}
            aria-label={t("Quebrar linhas longas")}
            data-tip={t("Quebra de linha")}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText size={14} />
          </button>
          <span className="viewer-sep" />
          <button
            className="icon-btn"
            aria-label={t("Abrir o arquivo no editor")}
            data-tip={t("Abrir o arquivo para editar")}
            onClick={editIt}
          >
            <SquarePen size={14} />
          </button>
        </div>
      </div>

      {menu && <ContextMenu anchor={menu} items={menuEntries()} onClose={() => setMenu(null)} />}

      <div className={`viewer-body dtab-body ${wrap ? "viewer-body--wrap" : ""}`}>{body}</div>

      <footer className="editor-status">
        <span className="editor-status-path" data-tip={doc.path}>
          {doc.path}
        </span>
        <span className="editor-status-right">
          <span className="editor-chip">{t("comparação")}</span>
          {parsed && parsed.hunks.length > 0 && (
            <span>{tn(parsed.hunks.length, "{n} pedaço", "{n} pedaços")}</span>
          )}
        </span>
      </footer>
    </div>
  );
}
