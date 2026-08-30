/**
 * Code editor — a file is **a tab beside the CLIs**, not a window over them.
 *
 * Opening something from the tree adds a tab to the pane's own bar, right
 * next to the agent that is editing it, at exactly the pane's size: two tabs
 * in one bar, one click apart. That is the whole point of this app — the file
 * and the agent working on it belong on the same surface — and it is why the
 * editor is not a modal.
 *
 * `EditorBody` is that surface and knows nothing about where it hangs.
 * `CodeEditor` (further down) is the same body raised as an overlay, used
 * only on the canvas, which has no tab bar to land in; there `Esc` pushes it
 * aside without closing anything — the documents and the drafts live in the
 * store, not in the window.
 *
 * What it does that an ordinary editor would not: **here the disk belongs to
 * someone else**. The agents rewrite the same files all the time, so:
 * - an open, untouched file follows the agent on its own (it reloads);
 * - a file with a draft turns into a "changed on disk" warning with both ways
 *   out (reload or carry on), never a silent overwrite;
 * - saving checks the timestamp: if the disk moved, the write stops and the
 *   user chooses to keep theirs.
 *
 * **Markdown gets a second face.** Half the files anyone opens here are
 * documents, not code — READMEs, specs, plans agents write and people read —
 * and raw markers are the wrong way to read a document. So a `.md` file
 * arrives with a formatting bar, an outline of its headings, and four ways to
 * look at it (`MdMode`): drawn while you write, raw, side by side, or read.
 * The buffer is always the file, character for character: the modes change
 * how it is painted, never what gets saved.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import "./editor.css";
import { basicSetup } from "codemirror";
import { completeAnyWord, type CompletionContext } from "@codemirror/autocomplete";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  type StateEffect,
} from "@codemirror/state";
import { EditorView, highlightTrailingWhitespace, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { gotoLine, openSearchPanel } from "@codemirror/search";
import {
  AlertTriangle,
  ChevronDown,
  Code2,
  Columns2,
  Image as ImageIcon,
  ListTree,
  PanelLeft,
  Save,
  Search,
  X,
} from "lucide-react";

import { FileTree } from "../FileTree";
import { diffLines } from "../../lib/lineDiff";
import { isMarkdown, languageLabel, loadLanguage } from "./cm";
import { editorExtras } from "./extras";
import { fileUri, languageIdFor } from "../../lib/lsp/servers";
import { flattenSymbols } from "../../lib/lsp/documentSymbols";
import { readActions } from "../../lib/lsp/codeActions";
import { diagnosticsAt, displayPath } from "../../lib/lsp/problems";
import { applyTextEdits, editSpans, editsFor, urisIn } from "../../lib/lsp/edits";
import { useLsp } from "../../stores/lspStore";
import { codeMetrics } from "./metrics";
import { formatBeforeSave } from "./format";
import { syntaxFor } from "./schemeSyntax";
import {
  applyGitChanges,
  cachedHeadText,
  gitGutterExt,
  gitStateOf,
  headTextFor,
  keepHeadText,
  peekHunkAt,
} from "./gitGutter";
import { hunkActions, hunkPeek, showHunkPeek } from "./hunkPeek";
import { minimalEdit, nextHunk, prevHunk, revertHunk } from "../../lib/hunks";
import { copyText } from "../../lib/clipboard";
import { DiffTab, isComparison } from "./DiffTab";
import { MarkdownPreview } from "./MarkdownPreview";
import { MediaView } from "./MediaView";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { fileMenu, mdBar, showSave } from "./chrome";
import { mdKeymap, runMd } from "./mdCommands";
import { mdLive } from "./mdLive";
import { openReplacePanel, yardSearch } from "./searchPanel";
import { Outline } from "./Outline";
import { observeVisibleLine } from "./surfaceCore";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useMarkdownNavigation } from "../../hooks/useMarkdownNavigation";
import { isTopLayer } from "../../lib/layers";
import { DocMemory } from "./docMemory";
import { applyBookmarks, bookmarkExt } from "./bookmarkGutter";
import { foldEffectsFor, foldsOf } from "./foldMemory";
import { parseRulers, rulers } from "./rulers";
import { snippetCompletions } from "./snippets";
import { outline as outlineOf, parseDoc, stats } from "../../lib/mddoc";
import { blockOf, type BlockKind } from "../../lib/mdedit";
import { openWebAddress } from "../../lib/openLink";
import { fileSize, mediaKind } from "../../lib/media";
import { closeDocTab, docTabMenu } from "../../lib/editorActions";
import { captureTextTarget, textMenuEntries } from "../../lib/textMenu";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { fileName, splitOsPath, toOsPath } from "../../lib/paths";
import {
  enclosing,
  hasSymbolSupport,
  symbolsOf,
  type CodeSymbol,
} from "../../lib/symbols";
import { ipc } from "../../lib/ipc";
import {
  isDirty,
  isReadOnly,
  tabLabel,
  useEditor,
  type OpenDoc,
} from "../../stores/editorStore";
import { useChanges } from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";
import { useExtensions } from "../../stores/extensionsStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";
import { t as translate, tn } from "../../lib/i18n";

/** The symbols rail with nothing to list — `Outline` translates it. */
const NO_SYMBOLS = "Sem símbolos ainda — funções e classes do arquivo aparecem aqui."; // i18n-ok

/**
 * One document's surface, whichever face it has: a comparison (the diff
 * opened from the Source Control tab) draws as the diff, everything else as
 * the editor. The hosts — the pane's tab panel and the canvas overlay — ask
 * for this and never need to know the difference.
 *
 * The subscription is a boolean on purpose: returning the document would
 * re-render this on every keystroke of a text file, and with it the editor
 * below, which `EditorBody` goes out of its way not to do.
 */
export function DocBody({ docId }: { docId: string }) {
  const comparison = useEditor((s) => !!s.docs.find((x) => x.id === docId)?.diff);
  if (comparison) {
    const doc = useEditor.getState().docs.find((x) => x.id === docId);
    if (doc && isComparison(doc)) return <DiffTab doc={doc} />;
  }
  return <EditorBody docId={docId} />;
}

/**
 * The editing surface of **one** document: path bar with the tools, the
 * markdown chrome, the text (or the page), and the status line.
 *
 * Deliberately unaware of where it is hanging. In the tab grid it is the body
 * of a pane, exactly the size the CLI next to it has; on the canvas — which
 * has no tab bar to land in — the overlay below wraps it. Everything it needs
 * comes from the store by `docId`, so both hosts show the same buffer, the
 * same draft and the same mode.
 */
export function EditorBody({ docId: id }: { docId: string }) {
  // The text buffer changes on every key, while the surrounding chrome only
  // changes on lifecycle/dirtiness transitions. Subscribe to that compact
  // projection so the bars do not reconcile per keystroke.
  const chromeKey = useEditor((s) => {
    const d = s.docs.find((x) => x.id === id);
    return JSON.stringify([
      s.wrap,
      s.mdMode,
      s.outline,
      s.docs.filter((x) => isDirty(x) && !isReadOnly(x)).length,
      d && [
        d.id,
        d.path,
        d.root,
        d.diskVersion,
        isDirty(d),
        d.modifiedAt,
        d.crlf,
        d.binary,
        d.media,
        d.size,
        d.truncated,
        d.lossy,
        d.stale,
        d.missing,
        d.error,
        d.saving,
      ],
    ]);
  });
  const { doc, sujos: dirtyDocs, wrap, mdMode, showOutline } = useMemo(() => {
    const state = useEditor.getState();
    return {
      doc: state.docs.find((d) => d.id === id) ?? null,
      sujos: state.docs.filter((d) => isDirty(d) && !isReadOnly(d)).length,
      wrap: state.wrap,
      mdMode: state.mdMode,
      showOutline: state.outline,
    };
  }, [chromeKey, id]);
  const showToast = useUI((s) => s.showToast);
  /** Is this project a git repository? Without one there is no HEAD to compare with. */
  const isRepo = useChanges((s) =>
    doc?.projectId ? (s.gitByProject[doc.projectId]?.isRepo ?? false) : false,
  );
  const t = useT();

  const cursorEl = useRef<HTMLButtonElement>(null);
  /** The live `EditorView`, for the buttons that need to talk to it (search). */
  const viewHolder = useRef<EditorView | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The reading pane, so the outline and the split view can scroll it. */
  const previewRef = useRef<HTMLDivElement>(null);
  /**
   * Where the caret is, in the two terms the markdown chrome needs: the line
   * (outline, scroll sync) and the block marker (which bar button is
   * pressed). Kept here and not in the store — it moves with every arrow key,
   * and the canvas has no business re-rendering for that.
   */
  const [caret, setCaret] = useState<{ line: number; block: BlockKind }>({
    line: 0,
    block: "paragraph",
  });
  /**
   * An `.svg` is image *and* text: it opens rendered (which is what you want to
   * see when clicking an icon) with a button for the code. Local rather than in
   * the store because it is about this tab, right now — the next one opens
   * rendered again.
   */
  const [showSource, setShowSource] = useState(false);
  useEffect(() => setShowSource(false), [id]);
  /**
   * The file's menu, opened from the path itself. Only the anchor is kept:
   * the entries are built at open time from whatever the store says then,
   * so a draft that appeared since the last click still shows "Salvar" live.
   */
  const [docMenu, setDocMenu] = useState<MenuAnchor | null>(null);

  const save = useCallback(async () => {
    // Prettier first, in the buffer (see `format.ts`): both ways in — Ctrl+S
    // and the toolbar button — funnel through here, so the store then saves
    // exactly what is on screen. No-op with the extension off.
    const target = useEditor.getState().docs.find((d) => d.id === id);
    if (viewHolder.current && target && !isReadOnly(target)) {
      await formatBeforeSave(viewHolder.current, target.path);
    }
    const ok = await useEditor.getState().save(id);
    if (!ok) {
      const err = useEditor.getState().docs.find((d) => d.id === id)?.error;
      if (err && !err.includes("CONFLITO")) showToast(err, "error");
    }
  }, [id, showToast]);

  // --- markdown ------------------------------------------------------------

  const md = doc ? isMarkdown(doc.path) && !doc.binary : false;
  const docRoot = doc?.root ?? "";
  const docPath = doc?.path ?? "";
  const docText = doc?.text ?? "";

  /**
   * The text the *rendered* side reads, one beat behind the buffer.
   *
   * Parsing a 30 KB README costs a few milliseconds, and paying it on every
   * keystroke of the split view is exactly how a preview turns into a
   * stutter. `useDeferredValue` lets the letters land first and the page
   * catch up, which is the order a person perceives anyway.
   */
  const previewText = useDeferredValue(docText);
  const headings = useMemo(
    () => (md && showOutline ? outlineOf(parseDoc(previewText)) : []),
    [md, showOutline, previewText],
  );
  // Off the deferred text as well: the counters are for the eye, and nobody
  // reads "1 217 palavras" tick over on every letter.
  const counts = useMemo(() => (md ? stats(previewText) : null), [md, previewText]);

  // --- code symbols ---------------------------------------------------------
  //
  // The same rail a markdown file gets, for code: functions, classes, types
  // (`lib/symbols.ts`). Markdown reads its outline from the parsed document;
  // code reads its own buffer.
  //
  // This used to wake only while the rail was open. It no longer can: the
  // symbol trail in the header is on whenever the file is code, and it is the
  // trail, not the rail, that answers "which method am I in" for a reader
  // three hundred lines down. The cost is a regex pass over the buffer, kept
  // off the typing path by `useDeferredValue`.
  const codeSymbolsOn = !md && !!doc && !doc.binary && hasSymbolSupport(docPath);
  const symbolText = useEditor((s) => {
    const d = s.docs.find((x) => x.id === id);
    return d && !d.binary && !isMarkdown(d.path) ? d.text : "";
  });
  const deferredSymbolText = useDeferredValue(symbolText);
  const regexSymbols = useMemo(
    () => (codeSymbolsOn ? symbolsOf(docPath, deferredSymbolText) : []),
    [codeSymbolsOn, docPath, deferredSymbolText],
  );
  /**
   * The same rail, from the language server when one is answering for this
   * file. It knows that `push` belongs to `Fila` rather than to the
   * indentation it shares with it, which the regexes can only guess at.
   * `null` = no server, or it has not answered yet, and then the regexes
   * are the rail, exactly as before.
   */
  const serverSymbols = useServerSymbols(doc, deferredSymbolText, codeSymbolsOn);
  const symbols = serverSymbols ?? regexSymbols;
  /**
   * The symbols the caret is standing inside, `class Fila › push`. The path
   * says which file you have open; this says where in it you are, which is
   * the question a long file actually raises.
   */
  const trail = useMemo(() => enclosing(symbols, caret.line), [symbols, caret.line]);

  // Read the mode late so these callbacks stay stable while the surface is
  // mounted. Notes use the same source/preview navigation contract.
  const isSplit = useCallback(() => useEditor.getState().mdMode === "split", []);
  const { goToLine, onCaret, onScrollLine } = useMarkdownNavigation({
    previewRef,
    viewRef: viewHolder,
    isSplit,
    setCaret,
  });

  const runCommand = useCallback((cmd: Parameters<typeof runMd>[1]) => {
    runMd(viewHolder.current, cmd);
  }, []);

  /**
   * Applies what a fix decided to change.
   *
   * The current document goes through CodeMirror as a set of spans, so the
   * whole thing is one undo step and the caret stays where the reader left
   * it. Other files the fix touches, a rename crosses files by definition,
   * are opened and left **dirty**: an edit the user has not seen yet is not
   * something to write to disk on their behalf.
   */
  const applyWorkspaceEdit = useCallback(
    (workspaceEdit: unknown, currentUri: string, root: string) => {
      const view = viewHolder.current;
      const here = editsFor(workspaceEdit, currentUri);
      if (view && here.length) {
        const spans = editSpans(view.state.doc.toString(), here);
        if (!spans) {
          showToast(t("A correção se sobrepõe a ela mesma; não apliquei nada."), "error");
          return;
        }
        view.dispatch({ changes: spans, userEvent: "input.complete" });
      }

      const elsewhere = urisIn(workspaceEdit).filter(
        (uri) => uri.toLowerCase() !== currentUri.toLowerCase(),
      );
      if (elsewhere.length === 0) return;

      void (async () => {
        let touched = 0;
        for (const uri of elsewhere) {
          const path = displayPath(root, uri);
          // Absolute means it landed outside the project; this editor only
          // reads inside a root, and it is not going to write outside one.
          if (/^[a-zA-Z]:\//.test(path)) continue;
          const edits = editsFor(workspaceEdit, uri);
          if (!edits.length) continue;
          await useEditor.getState().openFile(path);
          const opened = useEditor
            .getState()
            .docs.find((x) => x.root === root && x.path === path);
          if (!opened) continue;
          useEditor.getState().setText(opened.id, applyTextEdits(opened.text, edits));
          touched++;
        }
        if (touched > 0) {
          showToast(
            tn(touched, "Mais {n} arquivo mexido, sem salvar", "Mais {n} arquivos mexidos, sem salvar"),
          );
        }
      })();
    },
    [showToast, t, viewHolder],
  );

  /**
   * Ctrl+., what the language server can do about the line under the caret.
   *
   * The diagnostics go with the request because they *are* the request:
   * `tsserver` finds its fixes by the error code we hand back, and asking
   * with an empty context gets an empty answer. What comes back is filtered
   * to the actions this editor can actually perform (`lib/lsp/codeActions.ts`).
   */
  const [quickFix, setQuickFix] = useState<{
    anchor: MenuAnchor;
    entries: MenuEntry[];
  } | null>(null);

  const openQuickFix = useCallback(
    (at: { x: number; y: number }) => {
      const view = viewHolder.current;
      const d = useEditor.getState().docs.find((x) => x.id === id);
      const languageId = d ? languageIdFor(d.path) : null;
      if (!view || !d || !languageId || !d.root || d.binary) return;
      if (!useUI.getState().prefs.lspEnabled) return;

      const sel = view.state.selection.main;
      const from = view.state.doc.lineAt(sel.from);
      const to = view.state.doc.lineAt(sel.to);
      const uri = fileUri(d.root, d.path);
      const range = {
        start: { line: from.number - 1, character: sel.from - from.from },
        end: { line: to.number - 1, character: sel.to - to.from },
      };

      setQuickFix({ anchor: at, entries: [{ id: "wait", label: t("procurando…"), disabled: true }] });

      void useLsp
        .getState()
        .clientFor(d.root, languageId)
        .then(async (client) => {
          if (!client) return null;
          client.sync();
          return client.request<unknown, unknown>("textDocument/codeAction", {
            textDocument: { uri },
            range,
            context: {
              diagnostics: diagnosticsAt(useLsp.getState().problems, uri, from.number - 1),
            },
          });
        })
        .then((reply) => {
          const rows = readActions(reply);
          if (rows.length === 0) {
            setQuickFix(null);
            showToast(t("Nada a corrigir aqui."));
            return;
          }
          setQuickFix({
            anchor: at,
            entries: rows.map((row, i) => ({
              id: `fix-${i}`,
              label: row.title,
              onSelect: () => applyWorkspaceEdit(row.edit, uri, d.root),
            })),
          });
        })
        .catch(() => {
          setQuickFix(null);
          showToast(t("O servidor de linguagem não respondeu."), "error");
        });
    },
    [applyWorkspaceEdit, id, showToast, t, viewHolder],
  );

  const toggleTask = useCallback(
    (line: number) => useEditor.getState().toggleTask(id, line),
    [id],
  );

  /** A relative link in the preview opens the file it points at, as a tab. */
  const openPath = useCallback(
    (path: string) => {
      void useEditor
        .getState()
        .openFile(path)
        .catch(() => showToast(t("Não achei “{path}” no projeto.", { path }), "error"));
    },
    [showToast],
  );

  /**
   * An address for the web. It becomes a portal on the canvas — the only
   * place a page runs in this app — with the overlay (when it is the one
   * showing) stepping aside so the user sees where it landed.
   */
  const openUrl = useCallback((href: string) => {
    useEditor.getState().closeEditor();
    // `openWebAddress` is the one place that decides web-vs-path — the
    // notebook goes through it too, after sending its links to the
    // open-a-file command by mistake.
    if (!openWebAddress(href)) showToast(t("Não sei abrir “{href}”.", { href }), "error");
  }, [showToast]);

  /**
   * Ctrl+S from anywhere **inside this editor**, not only with the cursor in
   * the text: CodeMirror's keymap covers the surface, but clicking a toolbar
   * button takes focus away from it and the shortcut advertised in "Keyboard
   * shortcuts" became a silent nothing. Scoped to this body's DOM, because
   * there can be one per pane and each saves its own file.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "s") return;
      const target = e.target as Node | null;
      if (!target || !rootRef.current?.contains(target)) return;
      e.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!doc) return null;

  const lang = languageLabel(doc.path);
  const osPath = toOsPath(doc.root, doc.path);
  const crumb = splitOsPath(osPath);
  /** Image, video, audio or PDF — whatever the webview draws on its own. */
  const kind = mediaKind(doc.media);
  /**
   * When the surface is the viewer's and not the text's. It holds for every
   * file without text (where the card explains what it is), and for anything
   * that has a better face than its code — unless the code is asked for.
   */
  const viewing = doc.binary || (kind !== null && !showSource);
  const saveButton = showSave({ readOnly: isReadOnly(doc), dirty: isDirty(doc), saving: doc.saving });
  /**
   * Whether the header has a "how to look" group at all — the rule between
   * it and search only exists with something on both sides of it.
   */
  const hasViewGroup = md || codeSymbolsOn || (kind !== null && !doc.binary);
  /** What the formatting capsule carries — the modes ride it now. */
  const mdSlots = mdBar(md, mdMode);

  /**
   * Everything about the file as a thing on disk, in one menu under the path:
   * the tab's own menu (save, reload, copy path, show in folder, close…) plus
   * what this view adds — wrapping, or the default app for a picture.
   */
  const openDocMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setDocMenu({ x: r.left, y: r.bottom + 4 });
  };
  const docMenuEntries = () =>
    fileMenu(
      docTabMenu(doc, useEditor.getState().docs),
      { wrap, media: viewing, dirty: isDirty(doc), git: isRepo, eolCrlf: doc.crlf, encoding: doc.encoding },
      {
        toggleWrap: () => useEditor.getState().setWrap(!wrap),
        openExternal: () => {
          void ipc.openExternal(osPath).catch((e) => showToast(String(e), "error"));
        },
        compareHead: () =>
          useEditor.getState().openDiff(doc.path, {
            source: "tree",
            side: "head",
            origPath: null,
          }),
        compareSaved: () => useEditor.getState().openDiff(doc.path, { source: "draft" }),
        setEol: (crlf) => useEditor.getState().setEol(doc.id, crlf),
        reopenWith: (encoding) => {
          void useEditor.getState().reopenWith(doc.id, encoding);
        },
      },
    );

  return (
    <div className="editor-body" ref={rootRef}>
      {/* The document's header: its place on disk as the title (folder dimmed,
          name lit — and the file's menu behind it), and on the right only how
          to look at it. Part of the page, not a bar over it. */}
      <div className="editor-pathbar">
        <button
          className={`editor-crumb ${docMenu ? "is-open" : ""}`}
          data-tip-wrap=""
          data-tip={osPath}
          aria-label={t("{path} — ações do arquivo", { path: osPath })}
          aria-haspopup="menu"
          aria-expanded={docMenu !== null}
          onClick={openDocMenu}
        >
          <span className="editor-crumb-path">
            {crumb.dir && (
              <span className="editor-crumb-dir">
                {/* One LTR isolate inside an RTL box: the rtl is what puts the
                    ellipsis at the *start* of the folder chain, the isolate is
                    what keeps `C:\…\yard\` from coming out as `\C:\…\yard`. */}
                <span className="editor-crumb-ltr">{crumb.dir}</span>
              </span>
            )}
            <span className="editor-crumb-base">{crumb.base}</span>
          </span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>

        {trail.length > 0 && (
          <nav className="editor-trail" aria-label={t("Onde o cursor está no arquivo")}>
            {trail.map((symbol) => (
              <button
                key={`${symbol.line}:${symbol.text}`}
                className="editor-trail-step"
                onClick={() => goToLine(symbol.line)}
              >
                {symbol.text}
              </button>
            ))}
          </nav>
        )}

        <div className="editor-tools">
            {(md || codeSymbolsOn) && (
              <button
                className={`icon-btn ${showOutline ? "is-active" : ""}`}
                data-tip={md ? t("Sumário dos títulos") : t("Símbolos do arquivo")}
                aria-label={
                  md
                    ? t("Mostrar ou esconder o sumário")
                    : t("Mostrar ou esconder os símbolos do arquivo")
                }
                aria-pressed={showOutline}
                onClick={() => useEditor.getState().setOutline(!showOutline)}
              >
                <ListTree size={14} />
              </button>
            )}
            {kind && !doc.binary && (
              /* Only `.svg` reaches here — an image that is also text. */
              <button
                className={`icon-btn ${showSource ? "is-active" : ""}`}
                data-tip={showSource ? t("Ver desenhado") : t("Ver o código")}
                aria-label={showSource ? t("Ver desenhado") : t("Ver o código")}
                aria-pressed={showSource}
                onClick={() => setShowSource(!showSource)}
              >
                {showSource ? <ImageIcon size={14} /> : <Code2 size={14} />}
              </button>
            )}
            {/* Search is about text: out of place on a PNG's screen. */}
            {!viewing && (
              <>
                {hasViewGroup && <span className="viewer-sep" />}
                <button
                  className="icon-btn"
                  data-tip={t("Buscar no arquivo (Ctrl+F)")}
                  aria-label={t("Buscar no arquivo")}
                  onClick={() => {
                    const view = viewHolder.current;
                    if (view) {
                      // Focus first, open second: `openSearchPanel` puts the
                      // caret in the field, and focusing after would take it
                      // straight back out.
                      view.focus();
                      openSearchPanel(view);
                    }
                  }}
                >
                  <Search size={14} />
                </button>
              </>
            )}
            {dirtyDocs > 1 && (
              <button
                className="btn btn--ghost btn--sm"
                data-tip={t("Salvar os {n} arquivos com alterações", { n: dirtyDocs })}
                onClick={() => void useEditor.getState().saveAll()}
              >
                Salvar tudo
              </button>
            )}
            {/* The draft made visible: the button is there exactly while
                there is something to write. */}
            {saveButton && (
              <button
                className="btn btn--primary btn--sm editor-save"
                disabled={doc.saving}
                data-tip={t("Salvar (Ctrl+S)")}
                data-tip-at="right"
                onClick={() => void save()}
              >
                <Save size={12} aria-hidden="true" />
                {doc.saving ? t("salvando…") : t("Salvar")}
              </button>
            )}
          </div>
        </div>

        {docMenu && (
          <ContextMenu anchor={docMenu} items={docMenuEntries()} onClose={() => setDocMenu(null)} />
        )}
        {quickFix && (
          <ContextMenu
            anchor={quickFix.anchor}
            items={quickFix.entries}
            onClose={() => setQuickFix(null)}
          />
        )}

        <div className="editor-main">
          <div className="editor-stage">
            <DocBanner doc={doc} />
            {mdSlots.bar && (
              <MarkdownToolbar
                block={caret.block}
                run={runCommand}
                slots={mdSlots}
                mode={mdMode}
                onMode={(m) => useEditor.getState().setMdMode(m)}
                disabled={isReadOnly(doc)}
              />
            )}
            {viewing ? (
              <MediaView doc={doc} />
            ) : (
              <div className={`editor-panes ${md ? `is-md is-${mdMode}` : ""}`}>
                {(!md || mdMode !== "read") && (
                  <CmSurface
                    doc={doc}
                    wrap={wrap || (md && mdMode !== "source")}
                    live={md && (mdMode === "live" || mdMode === "split")}
                    onSave={() => void save()}
                    // Code too, not only markdown: the symbols rail follows
                    // the caret the same way the heading outline does.
                    onCaret={onCaret}
                    onQuickFix={openQuickFix}
                    onScrollLine={md ? onScrollLine : undefined}
                    cursorEl={cursorEl}
                    viewHolder={viewHolder}
                  />
                )}
                {md && (mdMode === "split" || mdMode === "read") && (
                  <div
                    className="editor-preview"
                    ref={previewRef}
                    // The reading pane is a document: it scrolls, it can be
                    // tabbed into, and a screen reader announces it as one.
                    tabIndex={0}
                  >
                    <MarkdownPreview
                      text={previewText}
                      root={docRoot}
                      path={docPath}
                      onTask={toggleTask}
                      onOpenPath={openPath}
                      onOpenUrl={openUrl}
                      onGoToLine={mdMode === "split" ? goToLine : undefined}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {md && showOutline && (
            <Outline entries={headings} line={caret.line} onGo={goToLine} />
          )}
          {codeSymbolsOn && showOutline && (
            <Outline
              entries={symbols}
              line={caret.line}
              onGo={goToLine}
              empty={NO_SYMBOLS}
            />
          )}
        </div>

        <footer className="editor-status">
          <span className="editor-status-path" data-tip={doc.path}>
            {doc.path}
          </span>
          <span className="editor-status-right">
            {/* On an image "read-only" says nothing: nobody expects to type into
                a PNG. The notice is for text that opened locked. */}
            {isReadOnly(doc) && !viewing && (
              <span className="editor-chip">{t("somente leitura")}</span>
            )}
            {isDirty(doc) && !isReadOnly(doc) && (
              <span className="editor-chip editor-chip--dirty">{t("não salvo")}</span>
            )}
            {counts && (
              <>
                {counts.tasks.total > 0 && (
                  <span data-tip={t("Tarefas concluídas neste arquivo")}>
                    {t("{done}/{total} tarefas", {
                      done: counts.tasks.done,
                      total: counts.tasks.total,
                    })}
                  </span>
                )}
                <span data-tip={t("{n} caracteres", { n: counts.chars })}>
                  {tn(counts.words, "{n} palavra", "{n} palavras")}
                </span>
                <span data-tip={t("Tempo de leitura, a 200 palavras por minuto")}>
                  {counts.minutes} min
                </span>
              </>
            )}
            {viewing ? (
              <>
                <span>{fileSize(doc.size)}</span>
                <span>{doc.media ?? t("binário")}</span>
              </>
            ) : (
              <>
                {/* A button, like VS Code's: clicking it asks for a line. */}
                <button
                  ref={cursorEl}
                  className="editor-lncol"
                  data-tip={t("Ir para a linha (Ctrl+G)")}
                  onClick={() => {
                    const view = viewHolder.current;
                    if (view) gotoLine(view);
                  }}
                >
                  Ln 1, Col 1
                </button>
                {/* Clickable, like VS Code's: it is the fastest way to say
                    "this file should be LF". Nothing is written here, the tab
                    just goes dirty (`lib/eol.ts`). */}
                <button
                  className="editor-lncol"
                  data-tip={
                    doc.crlf
                      ? t("Terminação de linha CRLF. Clique para LF")
                      : t("Terminação de linha LF. Clique para CRLF")
                  }
                  disabled={isReadOnly(doc)}
                  onClick={() => useEditor.getState().setEol(doc.id, !doc.crlf)}
                >
                  {doc.crlf ? "CRLF" : "LF"}
                </button>
                {/* Only the "no language" label is a sentence of ours; the rest
                    are names (TypeScript, JSON) and stay as they are. */}
                <span>{lang === "Texto" ? t("Texto") : lang}</span>
              </>
            )}
          </span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the overlay — canvas only, since it has no tab bar
// ---------------------------------------------------------------------------

/**
 * The editor as a window over the canvas.
 *
 * In the tab grid a file is a tab in the pane's own bar (`TerminalPane`), the
 * same size as the CLI beside it — that is where a document belongs, and it
 * is what the app does everywhere it can. The canvas has no tab bar to land
 * in: there the same body is raised as this overlay, with a strip of the open
 * files on top and the project tree on the side.
 */
export function CodeEditor() {
  const open = useEditor((s) => s.open);
  const activeId = useEditor((s) => s.activeId);
  const rail = useEditor((s) => s.rail);
  // The gate, checked here and not only where files are opened: a session
  // restored with `open` from a canvas would otherwise throw this window over
  // a tab grid that has a perfectly good bar to show the file in.
  const noTabs = useProjects((s) =>
    s.activeGroupId ? s.layoutOf(s.activeGroupId).surface === "canvas" : true,
  );
  const tabsKey = useEditor((s) =>
    s.docs.map((d) => `${d.id}:${isDirty(d)}:${d.stale}:${d.missing}`).join("|"),
  );
  const docs = useMemo(() => useEditor.getState().docs, [tabsKey]);
  const showToast = useUI((s) => s.showToast);
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [fileMenu, setFileMenu] = useState<
    { anchor: MenuAnchor; entries: MenuEntry[] } | null
  >(null);

  useDialogFocus(dialogRef, open, "editor");

  const close = useCallback(() => useEditor.getState().closeEditor(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Only the top surface handles the key (a modal may be above).
      if (!isTopLayer("editor")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const doc = docs.find((d) => d.id === activeId) ?? null;
  if (!open || !doc || !noTabs) return null;

  /**
   * Right-click inside the editor: the text first (it is a writing surface —
   * opening a menu that takes "paste" away from someone would be a bad deal),
   * then what can be done with the file. The target has to be read now,
   * before the menu opens and takes the focus away.
   */
  const openFileMenu = (e: React.MouseEvent, withText: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const ofFile = docTabMenu(doc, docs);
    const theText = withText ? textMenuEntries(captureTextTarget(e.nativeEvent), { app: false }) : [];
    setFileMenu({
      anchor: { x: e.clientX, y: e.clientY },
      entries: theText.length > 0 ? [...theText, { kind: "sep" }, ...ofFile] : ofFile,
    });
  };

  return (
    // Only the main button closes: with the right one the gesture is "open
    // the menu", and closing the editor underneath it would be the wrong answer.
    <div className="editor-backdrop" onMouseDown={(e) => e.button === 0 && close()}>
      <div
        ref={dialogRef}
        className="editor"
        role="dialog"
        aria-modal="true"
        aria-label={t("Editor — {path}", { path: doc.path })}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="editor-head">
          <button
            className={`icon-btn ${rail ? "is-active" : ""}`}
            data-tip={t("Mostrar ou esconder a árvore")}
            aria-pressed={rail}
            aria-label={t("Mostrar ou esconder a árvore de arquivos")}
            onClick={() => useEditor.getState().setRail(!rail)}
          >
            <PanelLeft size={14} />
          </button>

          <ul className="editor-tabs" role="tablist" aria-label={t("Arquivos abertos")}>
            {docs.map((d) => (
              // `role="presentation"` on the `li`: a `tablist` may only
              // contain tabs, and the list-item semantics sat between the two.
              <li
                key={d.id}
                role="presentation"
                className={`editor-tab-slot ${d.id === doc.id ? "is-active" : ""}`}
                onContextMenu={(e) => {
                  useEditor.getState().setActive(d.id);
                  // The clicked tab is the target; the editor body has a menu of its own.
                  e.preventDefault();
                  e.stopPropagation();
                  setFileMenu({
                    anchor: { x: e.clientX, y: e.clientY },
                    entries: docTabMenu(d, docs),
                  });
                }}
              >
                <button
                  role="tab"
                  aria-selected={d.id === doc.id}
                  tabIndex={d.id === doc.id ? 0 : -1}
                  className="editor-tab"
                  data-tip-wrap=""
                  data-tip={`${d.path}\n${d.root}`}
                  onClick={() => useEditor.getState().setActive(d.id)}
                  onAuxClick={(e) => {
                    // Middle button closes, as in any editor with tabs.
                    if (e.button === 1) void closeDocTab(d.id);
                  }}
                >
                  <span className="editor-tab-name">{tabLabel(d, docs)}</span>
                  {(d.stale || d.missing) && (
                    <AlertTriangle size={11} className="editor-tab-warn" />
                  )}
                </button>
                <button
                  type="button"
                  className="editor-tab-close"
                  aria-label={
                    isDirty(d) && !isReadOnly(d)
                      ? t("Fechar {name} (não salvo)", { name: fileName(d.path) })
                      : t("Fechar {name}", { name: fileName(d.path) })
                  }
                  onClick={() => void closeDocTab(d.id)}
                >
                  {isDirty(d) && !isReadOnly(d) ? (
                    <span className="editor-dot" aria-hidden="true" />
                  ) : (
                    <X size={11} aria-hidden="true" />
                  )}
                </button>
              </li>
            ))}
          </ul>

          <button
            className="icon-btn"
            data-tip-at="right"
            data-tip={t("Fechar o editor (Esc)")}
            aria-label={t("Fechar o editor")}
            onClick={close}
          >
            <X size={15} />
          </button>
        </header>

        {fileMenu && (
          <ContextMenu
            anchor={fileMenu.anchor}
            items={fileMenu.entries}
            onClose={() => setFileMenu(null)}
          />
        )}

        <div
          className="editor-overlay-main"
          onContextMenu={(e) => openFileMenu(e, true)}
        >
          {rail && (
            <nav className="editor-rail" aria-label={t("Arquivos do projeto")}>
              <FileTree
                activePath={doc.path}
                onOpen={(p) =>
                  void useEditor
                    .getState()
                    .openFile(p)
                    .catch((e) =>
                      showToast(t("Não consegui abrir: {reason}", { reason: String(e) }), "error"),
                    )
                }
              />
            </nav>
          )}
          <DocBody docId={doc.id} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// notices about the disk
// ---------------------------------------------------------------------------

function DocBanner({ doc }: { doc: OpenDoc }) {
  const t = useT();
  const conflict = doc.error?.includes("CONFLITO") ?? false;

  if (doc.missing) {
    return (
      <div className="editor-banner editor-banner--warn">
        <AlertTriangle size={13} aria-hidden="true" />
        <span>{t("Esse arquivo não está mais no disco — alguém apagou ou moveu.")}</span>
        <button
          className="btn btn--sm"
          onClick={() => void useEditor.getState().save(doc.id)}
        >
          {t("Gravar de volta")}
        </button>
        {/* `closeDocTab`, not `closeDoc`: the file is gone from disk, so the
            draft in this tab is the only copy of the text left — closing
            without the question would throw away exactly what the button
            beside it is offering to save. */}
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => void closeDocTab(doc.id)}
        >
          {t("Fechar a aba")}
        </button>
      </div>
    );
  }

  if (conflict || doc.stale) {
    return <ConflictBanner doc={doc} conflict={conflict} />;
  }

  if (doc.error) {
    return (
      <div className="editor-banner editor-banner--error">
        <AlertTriangle size={13} aria-hidden="true" />
        <span>{doc.error}</span>
      </div>
    );
  }

  if (doc.truncated) {
    return (
      <div className="editor-banner">
        {t(
          "Arquivo grande demais: só o começo foi carregado, e por isso ele abre em somente leitura.",
        )}
      </div>
    );
  }

  // The buffer is a lossy decode: every byte that is not UTF-8 is showing as
  // U+FFFD. Saving would write those diamonds over the real bytes, in the whole
  // file — including the lines nobody touched. Read-only is the only honest
  // answer until the editor knows how to decode (and write back) the original
  // encoding.
  if (doc.lossy) {
    return (
      <div className="editor-banner editor-banner--warn">
        <AlertTriangle size={13} aria-hidden="true" />
        <span>
          {t("Este arquivo não está em UTF-8 (provavelmente cp1252/latin-1). O que aparece como")}{" "}
          <code>�</code>{" "}
          {t(
            "é byte que não deu para ler, então ele abre em somente leitura — gravar trocaria os acentos originais por esse símbolo no arquivo inteiro. Converta o arquivo para UTF-8 para editá-lo aqui.",
          )}
        </span>
      </div>
    );
  }

  return null;
}

/**
 * The conflict, with the information that was missing to decide.
 *
 * Both ways out destroy one of the sides — reloading throws your text away,
 * overwriting throws the agent's away — and the choice used to be made blind
 * in an app whose premise is "agents edit your files while you work". "Ver a
 * diferença" reads the disk on the spot and shows both sides with the
 * diverging lines marked.
 */
function ConflictBanner({ doc, conflict }: { doc: OpenDoc; conflict: boolean }) {
  const t = useT();
  const [disk, setDisk] = useState<string | null>(null);
  const [diskError, setDiskError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const showDiff = () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setIsOpen(true);
    setDiskError(null);
    void ipc
      .fsReadText(doc.root, doc.path)
      .then((f) => setDisk(f.text))
      .catch((e) => setDiskError(String(e)));
  };

  // A failed overwrite keeps `stale` (the disk is still ahead) *and* sets
  // `error`. Without showing it here the user would see the same warning
  // twice in a row with no hint that the second attempt failed, and why.
  const writeFailure = doc.error && !conflict ? doc.error : null;
  return (
    <>
    <div className="editor-banner editor-banner--warn">
      <AlertTriangle size={13} aria-hidden="true" />
      <span>
        {writeFailure
          ? t("Não consegui gravar: {reason}", { reason: writeFailure })
          : conflict
            ? t("O arquivo mudou no disco desde que você o abriu — nada foi gravado.")
            : t("Um agente mexeu neste arquivo enquanto você editava.")}
      </span>
      <button
        className="btn btn--sm"
        aria-expanded={isOpen}
        data-tip={t("Compara o que está no disco com o seu texto, antes de escolher")}
        onClick={showDiff}
      >
        <Columns2 size={12} aria-hidden="true" />
        {isOpen ? t("Esconder a diferença") : t("Ver a diferença")}
      </button>
      <button
        className="btn btn--sm"
        data-tip={t("Joga fora o seu rascunho e traz a versão do disco")}
        onClick={() => void useEditor.getState().reload(doc.id)}
      >
        {t("Recarregar")}
      </button>
      <button
        className="btn btn--sm"
        disabled={doc.saving}
        data-tip={t("Grava o seu texto por cima do que está no disco")}
        onClick={() => void useEditor.getState().overwrite(doc.id)}
      >
        {doc.saving ? t("gravando…") : t("Salvar por cima")}
      </button>
    </div>
    {isOpen && (
      <ConflictDiff disk={disk} errorText={diskError} mine={doc.text} />
    )}
    </>
  );
}

/**
 * The two sides, side by side, with the diverging lines marked. Not the git
 * diff viewer (that one compares against HEAD): here the comparison is
 * disk × draft, a pair git never sees.
 */
function ConflictDiff({
  disk,
  errorText: error,
  mine,
}: {
  disk: string | null;
  errorText: string | null;
  mine: string;
}) {
  const t = useT();
  const sides = useMemo(() => {
    if (disk === null) return null;
    const onDisk = disk.split("\n");
    const mineLines = mine.split("\n");
    // One pass in each direction: each side marks what it has that differs
    // from the other. The diff budget is the gutter's; once blown, nobody
    // marks anything and both columns stay readable.
    return {
      disk: { lines: onDisk, marks: diffLines(mine, disk)?.marks },
      mine: { lines: mineLines, marks: diffLines(disk, mine)?.marks },
    };
  }, [disk, mine]);

  if (error) {
    return (
      <div className="editor-conflict editor-conflict--note">
        {t("Não consegui ler o arquivo no disco: {reason}", { reason: error })}
      </div>
    );
  }
  if (!sides) {
    return <div className="editor-conflict editor-conflict--note">{t("lendo o disco…")}</div>;
  }
  return (
    <div className="editor-conflict">
      {(["disk", "mine"] as const).map((side) => (
        <section key={side} className="editor-conflict-side">
          <h4>{side === "disk" ? t("No disco (agora)") : t("No seu editor")}</h4>
          <pre>
            {sides[side].lines.map((row, i) => {
              const mark = sides[side].marks?.get(i + 1);
              return (
                <span
                  key={i}
                  className={`editor-conflict-line ${mark ? `is-${mark}` : ""}`}
                >
                  <span className="editor-conflict-n">{i + 1}</span>
                  {row || " "}
                  {"\n"}
                </span>
              );
            })}
          </pre>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CodeMirror
// ---------------------------------------------------------------------------

/**
 * Alt+F5 and its shifted twin: the caret to the next change against HEAD,
 * with the panel opened on it. Wrapping, so three changes in a file become a
 * rotation instead of a walk that dead-ends.
 */
function goToHunk(view: EditorView, direction: 1 | -1): boolean {
  const { hunks } = gitStateOf(view);
  if (hunks.length === 0) return false;
  const here = view.state.doc.lineAt(view.state.selection.main.head).number;
  const hunk = direction === 1 ? nextHunk(hunks, here) : prevHunk(hunks, here);
  if (!hunk) return false;
  const line = view.state.doc.line(Math.min(Math.max(hunk.newFrom, 1), view.state.doc.lines));
  view.dispatch({
    selection: EditorSelection.cursor(line.from),
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
  peekHunkAt(view, line.number);
  return true;
}

/**
 * The outline, asked of the language server.
 *
 * Re-asked when the buffer settles, `text` is already the deferred copy, so
 * this rides the same "the user stopped typing" signal the regex rail does.
 * A reply that arrives for a file the editor has since left is dropped: the
 * request is slow enough for that to happen on every second tab switch.
 *
 * Failure is quiet on purpose. A server that does not implement
 * `documentSymbol`, is still indexing, or has just died answers nothing, and
 * the honest response to that is the rail the app has always had.
 */
function useServerSymbols(
  doc: OpenDoc | null,
  text: string,
  enabled: boolean,
): CodeSymbol[] | null {
  const lspEnabled = useUI((s) => s.prefs.lspEnabled);
  const [symbols, setSymbols] = useState<CodeSymbol[] | null>(null);

  // A new file starts with no answer rather than the last file's.
  useEffect(() => setSymbols(null), [doc?.id]);

  useEffect(() => {
    if (!doc) return;
    const languageId = languageIdFor(doc.path);
    if (!enabled || !lspEnabled || !doc.root || !languageId || doc.binary) return;
    let alive = true;
    void useLsp
      .getState()
      .clientFor(doc.root, languageId)
      .then(async (client) => {
        if (!alive || !client) return;
        // The server has to be looking at the text we are asking about.
        client.sync();
        const reply = await client.request<{ textDocument: { uri: string } }, unknown>(
          "textDocument/documentSymbol",
          { textDocument: { uri: fileUri(doc.root, doc.path) } },
        );
        if (!alive) return;
        const rows = flattenSymbols(reply);
        setSymbols(rows.length ? rows : null);
      })
      .catch(() => {
        // No `documentSymbol`, still indexing, or gone. The regex rail stands.
      });
    return () => {
      alive = false;
    };
  }, [doc?.id, doc?.root, doc?.path, doc?.binary, text, enabled, lspEnabled]);

  return symbols;
}

/**
 * Puts back what the last session had folded in this file. The ranges come
 * from a record on disk and the file may have been rewritten since, so
 * `foldEffectsFor` drops whatever no longer fits rather than folding a range
 * that now covers something else.
 */
function restoreFolds(view: EditorView, doc: OpenDoc): void {
  const folds = useEditor.getState().folds[doc.id];
  if (!folds?.length) return;
  const effects = foldEffectsFor(folds, view.state.doc.length);
  if (effects.length) view.dispatch({ effects });
}

/**
 * The snippet table for a path, as a completion source. Empty for a language
 * with no table, and then the extension is nothing at all.
 */
function snippetSource(path: string) {
  const rows = snippetCompletions(path);
  if (rows.length === 0) return [];
  return EditorState.languageData.of(() => [
    {
      autocomplete: (context: CompletionContext) => {
        const word = context.matchBefore(/\w+/);
        if (!word || (word.from === word.to && !context.explicit)) return null;
        return { from: word.from, options: rows, validFor: /^\w*$/ };
      },
    },
  ]);
}

/** Extensions that lock editing — empty when the file is writable. */
function readOnlyExtension(readOnly: boolean) {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

interface SurfaceProps {
  doc: OpenDoc;
  wrap: boolean;
  /** Markdown drawn as it is written — see `mdLive`. */
  live: boolean;
  onSave: () => void;
  /** Set for markdown only: the bar and the outline follow the caret. */
  onCaret?: (at: { line: number; block: BlockKind }) => void;
  /** Ctrl+., the page opens the quick-fix menu at this point on screen. */
  onQuickFix?: (at: { x: number; y: number }) => void;
  /** First line on screen, as the surface is scrolled — the split view's sync. */
  onScrollLine?: (line: number) => void;
  cursorEl: { current: HTMLElement | null };
  viewHolder: { current: EditorView | null };
}

function CmSurface({
  doc,
  wrap,
  live,
  onSave,
  onCaret,
  onQuickFix,
  onScrollLine,
  cursorEl,
  viewHolder,
}: SurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /**
   * State per file: switching tabs preserves history, cursor, folds **and**
   * the scroll position. The state carries the first three; the scroll rides
   * along as CodeMirror's own snapshot, because it lives in the DOM and not
   * in the state (`docMemory.ts`).
   */
  const statesRef = useRef(new DocMemory<EditorState, StateEffect<unknown>>(40));
  const wrapComp = useRef(new Compartment()).current;
  const languageComp = useRef(new Compartment()).current;
  // Read-only has to be reconfigurable, not baked into the `EditorState`: a
  // file that goes past the read cap (or turns binary) after a "Reload from
  // disk" lit the warning and disabled Save, but the surface kept accepting
  // typing that had nowhere to go.
  const readOnlyComp = useRef(new Compartment()).current;
  // The live-preview decorations come and go with the markdown mode, and the
  // markdown keymap only exists for markdown files: both are per-state
  // decisions the user can flip without losing the buffer.
  const liveComp = useRef(new Compartment()).current;
  // Store-driven extras (rainbow brackets, TODO highlight, minimap, guides,
  // CSS colors) and the active color scheme: the switch in Ajustes
  // modal has to reach a file that is already open.
  const extrasComp = useRef(new Compartment()).current;
  const syntaxComp = useRef(new Compartment()).current;
  // Font size, line height, tab width and line-number column: Preferences
  // have to reach the file that is already on screen.
  const metricsComp = useRef(new Compartment()).current;
  // The language-server plugin of the open file: one per (root, server)
  // client, shared through `lspStore`; empty when the preference is off,
  // the file has no root, or nobody serves its language.
  const lspComp = useRef(new Compartment()).current;
  const lspEnabled = useUI((s) => s.prefs.lspEnabled);
  const rainbow = useExtensions((s) => s.enabled["rainbow-brackets"] === true);
  const all = useExtensions((s) => s.enabled["todo-highlight"] === true);
  const minimap = useExtensions((s) => s.enabled.minimap === true);
  const indent = useExtensions((s) => s.enabled["indent-guides"] === true);
  const cssColors = useExtensions((s) => s.enabled["css-colors"] === true);
  // The editor's half of a colour scheme: the `code` slot, which the store
  // keeps apart from the terminal's (`lib/schemeChoice.ts`).
  const schemeId = useExtensions((s) => s.scheme.code);
  const flags = useMemo(
    () => ({ rainbow, todos: all, minimap, indent, cssColors }),
    [rainbow, all, minimap, indent, cssColors],
  );
  // One scalar per subscription, as the rest of the app does with `prefs`:
  // the whole object is rebuilt on every splitter drag, and the surface must
  // not reconfigure itself because of that.
  const fontSize = useUI((s) => s.prefs.codeFontSize);
  const lineHeight = useUI((s) => s.prefs.codeLineHeight);
  const tabSize = useUI((s) => s.prefs.codeTabSize);
  const hardTabs = useUI((s) => s.prefs.codeHardTabs);
  const lineNumbers = useUI((s) => s.prefs.codeLineNumbers);
  const metrics = useMemo(
    () => ({ fontSize, lineHeight, tabSize, hardTabs, lineNumbers }),
    [fontSize, lineHeight, tabSize, hardTabs, lineNumbers],
  );
  // Column guides. Free text in Preferences, cleaned up here once so the
  // extension list only ever sees a sane, ordered list (`rulers.ts`).
  const rulerPref = useUI((s) => s.prefs.codeRulers);
  const rulerColumns = useMemo(() => parseRulers(rulerPref), [rulerPref]);
  /** The marks of the document on screen, as the store holds them. */
  const docMarks = useEditor((s) => s.marks[doc.id]);
  const idRef = useRef(doc.id);
  const languageRequest = useRef(0);
  const lastPublished = useRef<{ id: string; text: string } | null>(null);
  // The handlers go into the `EditorState`, created once per file: without
  // the refs, an old tab would keep calling their stale version.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const caretRef = useRef(onCaret);
  caretRef.current = onCaret;
  const quickFixRef = useRef(onQuickFix);
  quickFixRef.current = onQuickFix;
  const showToastRef = useRef(useUI.getState().showToast);
  showToastRef.current = useUI((s) => s.showToast);
  const scrollRef = useRef(onScrollLine);
  scrollRef.current = onScrollLine;
  /** Last position published upward — the parent only hears about changes. */
  const lastCaret = useRef<{ line: number; block: BlockKind } | null>(null);
  /** Last line handed to the navigation trail, see the update listener. */
  const navLine = useRef(-1);
  const rulersComp = useRef(new Compartment()).current;
  /** Debounce of the git gutter while typing — cache only, no IPC on a key. */
  const gitTimer = useRef(0);
  const gitRef = useRef<(view: EditorView, id: string) => void>(() => {});
  gitRef.current = (view, id) => {
    if (gitTimer.current) clearTimeout(gitTimer.current);
    gitTimer.current = window.setTimeout(() => {
      gitTimer.current = 0;
      if (viewRef.current !== view || idRef.current !== id) return;
      const head = cachedHeadText(id);
      // Never fetched yet: the effect below owns the first (async) answer.
      if (head === undefined) return;
      applyGitChanges(view, head);
    }, 500);
  };

  const configureLanguage = useCallback(
    (d: OpenDoc) => {
      const request = ++languageRequest.current;
      void loadLanguage(d.path)
        .then((extension) => {
          const view = viewRef.current;
          if (request !== languageRequest.current || idRef.current !== d.id || !view) return;
          view.dispatch({
            effects: languageComp.reconfigure(extension ? [extension] : []),
          });
        })
        .catch((error) => {
          console.warn(`[yard] falha ao carregar linguagem de ${d.path}`, error);
        });
    },
    [languageComp],
  );

  const makeState = useCallback(
    (d: OpenDoc) => {
      return EditorState.create({
        doc: d.text,
        extensions: [
          basicSetup,
          // The app's find bar, above the text (`searchPanel.ts`) — in place of
          // CodeMirror's default form at the bottom.
          yardSearch,
          // Size, line height, tabs and numbering from Preferences. It beats
          // `yardTheme`'s factory size by precedence, not by sitting here —
          // see `metrics.ts`.
          metricsComp.of(codeMetrics(metrics)),
          lspComp.of([]),
          syntaxComp.of(syntaxFor(schemeId)),
          // How each line stands against HEAD — green born, blue changed,
          // red wedge where lines died. The marks arrive by effect
          // (`applyGitChanges`); with none, the strip is invisible.
          gitGutterExt,
          // Clicking one of those marks opens what the line was, with a way
          // to put it back (`hunkPeek.ts`).
          hunkPeek,
          hunkActions.of({
            revert: (hunk) => {
              const view = viewRef.current;
              if (!view) return;
              const { head } = gitStateOf(view);
              if (head === null) return;
              const before = view.state.doc.toString();
              const after = revertHunk(before, head, hunk);
              // `null` = the hunk no longer fits the text. The marks are a
              // debounce behind the buffer, so this is a real state and the
              // honest answer to it is to do nothing.
              if (after === null) {
                showToastRef.current(
                  translate("O trecho mudou desde que este painel abriu; não reverti nada."),
                  "error",
                );
                view.dispatch({ effects: showHunkPeek.of(null) });
                return;
              }
              const edit = minimalEdit(before, after);
              view.dispatch({
                ...(edit ? { changes: edit } : {}),
                effects: showHunkPeek.of(null),
              });
            },
            copy: (lines) => void copyText(lines.join("\n")),
          }),
          // Line marks, painted on the line number itself (`bookmarkGutter.ts`).
          bookmarkExt,
          rulersComp.of(rulers(rulerColumns)),
          wrapComp.of(wrap ? EditorView.lineWrapping : []),
          languageComp.of([]),
          readOnlyComp.of(readOnlyExtension(isReadOnly(d))),
          liveComp.of(live ? mdLive : []),
          extrasComp.of(editorExtras(flags)),
          // The formatting shortcuts belong to markdown files only: in a
          // `.ts`, Ctrl+B has to stay CodeMirror's.
          isMarkdown(d.path) ? mdKeymap : [],
          // Words already in the buffer complete as you type — the floor an
          // IDE gives every language, under whatever the grammar adds (HTML
          // tags, CSS properties, SQL keywords). Code only: markdown is
          // prose, and prose suggesting its own words back is noise. The
          // trailing-whitespace tint is code-only for the same reason: in
          // markdown two trailing spaces are a hard line break, not dirt.
          isMarkdown(d.path)
            ? []
            : [
                EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
                // The shapes worth not typing, under everything else in the
                // list: a server knows this project, a snippet only knows the
                // language (`snippets.ts`).
                snippetSource(d.path),
                highlightTrailingWhitespace(),
              ],
          // `Prec.high`: `basicSetup`'s search keymap owns Mod-g (find next),
          // but every IDE the user comes from spells "go to line" this way.
          Prec.high(
            keymap.of([
              indentWithTab,
              { key: "Mod-g", run: gotoLine, preventDefault: true },
              { key: "Mod-h", run: openReplacePanel, preventDefault: true },
              // The way home from F12, Ctrl+P and a path the build printed.
              // Free on Windows: CodeMirror only binds Alt+arrow on macOS.
              {
                key: "Alt-ArrowLeft",
                preventDefault: true,
                run: () => {
                  useEditor.getState().navBack();
                  return true;
                },
              },
              {
                key: "Alt-ArrowRight",
                preventDefault: true,
                run: () => {
                  useEditor.getState().navForward();
                  return true;
                },
              },
              // Line marks. The whole family hangs off F2 on purpose: F2 and
              // Shift+F2 are already the symbol keys, and a Ctrl+Alt binding
              // would be AltGr on the ABNT keyboard this app is written for.
              // Quick fix. The menu belongs to the page, not to the
              // surface, so this only reports where the caret is.
              {
                key: "Mod-.",
                preventDefault: true,
                run: (view) => {
                  const head = view.state.selection.main.head;
                  const box = view.coordsAtPos(head);
                  quickFixRef.current?.(
                    box
                      ? { x: box.left, y: box.bottom + 4 }
                      : { x: 0, y: 0 },
                  );
                  return true;
                },
              },
              // Walking the changes against HEAD, the keys VS Code uses.
              {
                key: "Alt-F5",
                preventDefault: true,
                run: (view) => goToHunk(view, 1),
              },
              {
                key: "Shift-Alt-F5",
                preventDefault: true,
                run: (view) => goToHunk(view, -1),
              },
              {
                key: "Ctrl-F2",
                preventDefault: true,
                run: (view) => {
                  const line = view.state.doc.lineAt(view.state.selection.main.head);
                  useEditor.getState().toggleMark(d.id, line.number - 1);
                  return true;
                },
              },
              {
                key: "Alt-F2",
                preventDefault: true,
                run: () => {
                  useEditor.getState().jumpMark(1);
                  return true;
                },
              },
              {
                key: "Shift-Alt-F2",
                preventDefault: true,
                run: () => {
                  useEditor.getState().jumpMark(-1);
                  return true;
                },
              },
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  saveRef.current();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const text = u.state.doc.toString();
              lastPublished.current = { id: d.id, text };
              useEditor.getState().setText(d.id, text);
              // The git gutter follows the typing on a debounce — from the
              // cached HEAD text only, never IPC on a keystroke.
              gitRef.current(u.view, d.id);
            }
            if (u.docChanged || u.selectionSet) {
              const sel = u.state.selection.main;
              const line = u.state.doc.lineAt(sel.head);
              const selected = sel.to - sel.from;
              if (cursorEl.current) {
                cursorEl.current.textContent =
                  `Ln ${line.number}, Col ${sel.head - line.from + 1}` +
                  (selected > 0 ? ` (${selected} sel.)` : "");
              }
              // The navigation trail. Only when the *line* moved: a caret
              // walking along one line is not travel, and a store write per
              // keystroke would be paid by every subscriber.
              if (navLine.current !== line.number) {
                navLine.current = line.number;
                useEditor.getState().arriveAt({ id: d.id, line: line.number - 1 });
              }
              // Upward only when it *means* something different: typing along
              // a line changes neither the outline's section nor which bar
              // button is pressed, and re-rendering for it would put a React
              // pass on every keystroke.
              const publish = caretRef.current;
              if (publish) {
                const at = {
                  line: line.number - 1,
                  // `blockOf` reads the whole text to name the markdown block
                  // under the caret — a cost only the markdown bar needs. In
                  // code the caret feeds the symbols rail, which is per-line.
                  block: isMarkdown(d.path)
                    ? blockOf(u.state.doc.toString(), sel.head)
                    : ("paragraph" as BlockKind),
                };
                const before = lastCaret.current;
                if (!before || before.line !== at.line || before.block !== at.block) {
                  lastCaret.current = at;
                  publish(at);
                }
              }
            }
          }),
        ],
      });
    },
    [cursorEl, extrasComp, flags, languageComp, live, liveComp, lspComp, metrics, metricsComp, readOnlyComp, rulerColumns, rulersComp, schemeId, syntaxComp, wrap, wrapComp],
  );

  // Mounts once; switching files is `setState`, not a remount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ state: makeState(doc), parent: host });
    viewRef.current = view;
    viewHolder.current = view;
    statesRef.current.remember(doc.id, view.state, null);
    configureLanguage(doc);
    restoreFolds(view, doc);
    view.focus();

    // Scrolling the source drags the rendered page along. Read from the top
    // edge of the viewport (`posAtCoords`) instead of from the caret: in the
    // split view the eye is scrolling, not writing. One frame at a time —
    // a scroll fires far more often than a repaint is worth.
    const stopScroll = observeVisibleLine(view, () => scrollRef.current);

    return () => {
      languageRequest.current++;
      if (gitTimer.current) clearTimeout(gitTimer.current);
      stopScroll();
      // The window is going: hand the folds over before the state does.
      useEditor.getState().setFolds(idRef.current, foldsOf(view.state));
      view.destroy();
      viewRef.current = null;
      viewHolder.current = null;
    };
    // Single mount: the switches are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switched tabs: store the previous state and restore (or create) the new one.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || idRef.current === doc.id) return;
    // The file being left: its state, where it was scrolled to, and what it
    // had folded, the last one because folds outlive the window.
    useEditor.getState().setFolds(idRef.current, foldsOf(view.state));
    statesRef.current.remember(idRef.current, view.state, view.scrollSnapshot());
    idRef.current = doc.id;
    const stored = statesRef.current.recall(doc.id);
    view.setState(stored?.state ?? makeState(doc));
    configureLanguage(doc);
    // A state coming back from the memory already carries its folds; a fresh
    // one has to be told what the last session left folded.
    if (!stored) restoreFolds(view, doc);
    // A stored state was born with the previous line wrapping (and read-only
    // setting).
    view.dispatch({
      effects: [
        wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []),
        readOnlyComp.reconfigure(readOnlyExtension(isReadOnly(doc))),
        liveComp.reconfigure(live ? mdLive : []),
        extrasComp.reconfigure(editorExtras(flags)),
        syntaxComp.reconfigure(syntaxFor(schemeId)),
        metricsComp.reconfigure(codeMetrics(metrics)),
      ],
    });
    // The scroll goes back last, in a transaction of its own: line wrapping
    // and the font metrics were just reconfigured above, and a height that
    // changes after the scroll lands leaves the reader a few lines off.
    if (stored?.scroll) view.dispatch({ effects: stored.scroll });
    view.focus();
    // A different file means a different caret: publish it so the bar and the
    // outline are about *this* document from the first frame.
    lastCaret.current = null;
    navLine.current = -1;
    const sel = view.state.selection.main;
    useEditor
      .getState()
      .arriveAt({ id: doc.id, line: view.state.doc.lineAt(sel.head).number - 1 });
    caretRef.current?.({
      line: view.state.doc.lineAt(sel.head).number - 1,
      block: isMarkdown(doc.path)
        ? blockOf(view.state.doc.toString(), sel.head)
        : ("paragraph" as BlockKind),
    });
    // The whole `doc` would change on every key; only the path matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  // The git gutter's other half: what the file looked like at HEAD. Re-asked
  // when fresh contents arrive from disk (save, reload, an agent's write) —
  // typing between those refreshes only the diff, from the cached answer.
  // --- language server (LSP): the plugin for this file, from the shared client ---
  //
  // Declared after the doc-switch effect on purpose: a restored state still
  // carries the compartment of the file it was saved with, and this runs
  // after `setState` to put the right plugin (or nothing) in its place. The
  // plugin opens the file on the server when created and closes it when the
  // compartment changes or the view is destroyed.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const languageId = languageIdFor(doc.path);
    if (!lspEnabled || !doc.root || !languageId || doc.binary) {
      view.dispatch({ effects: lspComp.reconfigure([]) });
      return;
    }
    let alive = true;
    void useLsp
      .getState()
      .clientFor(doc.root, languageId)
      .then((client) => {
        if (!alive || viewRef.current !== view || idRef.current !== doc.id) return;
        view.dispatch({
          effects: lspComp.reconfigure(
            client ? client.plugin(fileUri(doc.root, doc.path), languageId) : [],
          ),
        });
      });
    return () => {
      alive = false;
    };
  }, [doc.id, doc.root, doc.path, doc.binary, lspEnabled, lspComp]);

  useEffect(() => {
    if (idRef.current !== doc.id || !viewRef.current) return;
    let alive = true;
    void headTextFor(
      { id: doc.id, root: doc.root, path: doc.path },
      `${doc.diskVersion}:${doc.modifiedAt}`,
    ).then((head) => {
      const view = viewRef.current;
      if (!alive || !view || idRef.current !== doc.id) return;
      applyGitChanges(view, head);
    });
    return () => {
      alive = false;
    };
  }, [doc.id, doc.root, doc.path, doc.diskVersion, doc.modifiedAt]);

  // A pending "put the caret here" — a search hit, mostly. Consumed once:
  // the jump must not replay when the user scrolls away and comes back.
  const reveal = useEditor((s) => s.reveal);
  useEffect(() => {
    if (!reveal || reveal.id !== doc.id) return;
    const view = viewRef.current;
    if (!view || idRef.current !== doc.id) return;
    const target = view.state.doc.line(
      Math.min(Math.max(reveal.line, 1), view.state.doc.lines),
    );
    view.dispatch({
      selection: EditorSelection.cursor(target.from),
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    view.focus();
    useEditor.getState().clearReveal();
  }, [reveal, doc.id]);

  // The text came from outside (reloaded from disk, written by an agent).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || idRef.current !== doc.id) return;
    const echo = lastPublished.current;
    if (echo?.id === doc.id && echo.text === doc.text) {
      lastPublished.current = null;
      return;
    }
    if (view.state.doc.toString() === doc.text) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.text },
    });
  }, [doc.text, doc.id]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap, wrapComp]);

  // Switched markdown mode: the decorations go on or off in place — no new
  // state, so the undo history, the scroll and the caret all stay put.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: liveComp.reconfigure(live ? mdLive : []) });
  }, [live, liveComp]);

  // The metrics changed in Preferences with a file on screen. The swap is in
  // place — the buffer, the history and the cursor stay — and `requestMeasure`
  // is what makes CodeMirror re-measure the character width: without it, the
  // cursor and the scrolling would stay computed at the old size until the
  // next event.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: metricsComp.reconfigure(codeMetrics(metrics)) });
    view.requestMeasure();
  }, [metrics, metricsComp]);

  // Flipped in Ajustes with a file on screen: same in-place swap.
  // The cached states of the other tabs catch up in the tab-switch dispatch.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        extrasComp.reconfigure(editorExtras(flags)),
        syntaxComp.reconfigure(syntaxFor(schemeId)),
      ],
    });
  }, [flags, schemeId, extrasComp, syntaxComp]);

  // The file became (or stopped being) read-only underneath — a "Reload from
  // disk" that brought back a file that is too large, for instance.
  const readOnly = isReadOnly(doc);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || idRef.current !== doc.id) return;
    view.dispatch({
      effects: readOnlyComp.reconfigure(readOnlyExtension(readOnly)),
    });
  }, [readOnly, doc.id, readOnlyComp]);

  // The line marks of the document on screen. They live in the store (they
  // outlive the tab), and the view is only told what to paint.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || idRef.current !== doc.id) return;
    applyBookmarks(view, docMarks ?? []);
  }, [docMarks, doc.id]);

  // Column guides follow the preference without rebuilding the state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: rulersComp.reconfigure(rulers(rulerColumns)) });
  }, [rulerColumns, rulersComp]);

  // Closed tabs need not keep state (nor the text that came with it).
  const openDocs = useEditor((s) => s.docs.map((d) => d.id).join("\n"));
  useEffect(() => {
    const alive = new Set(openDocs.split("\n"));
    statesRef.current.keep(alive);
    keepHeadText(alive);
  }, [openDocs]);

  return (
    <div
      className={`editor-surface ${readOnly ? "is-readonly" : ""}`}
      ref={hostRef}
    />
  );
}
