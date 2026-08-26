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
import { completeAnyWord } from "@codemirror/autocomplete";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
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
import { useLsp } from "../../stores/lspStore";
import { codeMetrics } from "./metrics";
import { formatBeforeSave } from "./format";
import { syntaxFor } from "./schemeSyntax";
import {
  applyGitChanges,
  cachedHeadText,
  dropHeadText,
  gitGutterExt,
  headTextFor,
} from "./gitGutter";
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
import { LruCache } from "../../lib/lru";
import { outline as outlineOf, parseDoc, stats } from "../../lib/mddoc";
import { blockOf, type BlockKind } from "../../lib/mdedit";
import { openWebAddress } from "../../lib/openLink";
import { fileSize, mediaKind } from "../../lib/media";
import { closeDocTab, docTabMenu } from "../../lib/editorActions";
import { captureTextTarget, textMenuEntries } from "../../lib/textMenu";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { fileName, splitOsPath, toOsPath } from "../../lib/paths";
import { hasSymbolSupport, symbolsOf } from "../../lib/symbols";
import { ipc } from "../../lib/ipc";
import {
  isDirty,
  isReadOnly,
  tabLabel,
  useEditor,
  type OpenDoc,
} from "../../stores/editorStore";
import { useProjects } from "../../stores/projectsStore";
import { SCHEME_IDS } from "../../lib/colorSchemes";
import { useExtensions } from "../../stores/extensionsStore";
import { useUI } from "../../stores/uiStore";
import type { ExtensionId } from "../../lib/extensions";
import { useT } from "../../hooks/useT";
import { tn } from "../../lib/i18n";

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
  // code reads its own buffer — through a dedicated subscription that only
  // wakes while the rail is showing, so a closed outline costs nothing.
  const codeSymbolsOn = !md && !!doc && !doc.binary && hasSymbolSupport(docPath);
  const symbolText = useEditor((s) => {
    if (!s.outline) return "";
    const d = s.docs.find((x) => x.id === id);
    return d && !d.binary && !isMarkdown(d.path) ? d.text : "";
  });
  const deferredSymbolText = useDeferredValue(symbolText);
  const symbols = useMemo(
    () => (codeSymbolsOn && showOutline ? symbolsOf(docPath, deferredSymbolText) : []),
    [codeSymbolsOn, showOutline, docPath, deferredSymbolText],
  );

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
      { wrap, media: viewing },
      {
        toggleWrap: () => useEditor.getState().setWrap(!wrap),
        openExternal: () => {
          void ipc.openExternal(osPath).catch((e) => showToast(String(e), "error"));
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
                <span>{doc.crlf ? "CRLF" : "LF"}</span>
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
  onScrollLine,
  cursorEl,
  viewHolder,
}: SurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** State per file: switching tabs preserves history, cursor and scroll. */
  const statesRef = useRef(new LruCache<string, EditorState>(40));
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
  // CSS colors) and the active color scheme: the switch in the Extensões
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
  const schemeId = useExtensions((s) =>
    SCHEME_IDS.find((id) => s.enabled[id as ExtensionId] === true),
  );
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
  const idRef = useRef(doc.id);
  const languageRequest = useRef(0);
  const lastPublished = useRef<{ id: string; text: string } | null>(null);
  // The handlers go into the `EditorState`, created once per file: without
  // the refs, an old tab would keep calling their stale version.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const caretRef = useRef(onCaret);
  caretRef.current = onCaret;
  const scrollRef = useRef(onScrollLine);
  scrollRef.current = onScrollLine;
  /** Last position published upward — the parent only hears about changes. */
  const lastCaret = useRef<{ line: number; block: BlockKind } | null>(null);
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
                highlightTrailingWhitespace(),
              ],
          // `Prec.high`: `basicSetup`'s search keymap owns Mod-g (find next),
          // but every IDE the user comes from spells "go to line" this way.
          Prec.high(
            keymap.of([
              indentWithTab,
              { key: "Mod-g", run: gotoLine, preventDefault: true },
              { key: "Mod-h", run: openReplacePanel, preventDefault: true },
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
    [cursorEl, extrasComp, flags, languageComp, live, liveComp, lspComp, metrics, metricsComp, readOnlyComp, schemeId, syntaxComp, wrap, wrapComp],
  );

  // Mounts once; switching files is `setState`, not a remount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ state: makeState(doc), parent: host });
    viewRef.current = view;
    viewHolder.current = view;
    statesRef.current.set(doc.id, view.state);
    configureLanguage(doc);
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
    statesRef.current.set(idRef.current, view.state);
    idRef.current = doc.id;
    const stored = statesRef.current.get(doc.id);
    view.setState(stored ?? makeState(doc));
    configureLanguage(doc);
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
    view.focus();
    // A different file means a different caret: publish it so the bar and the
    // outline are about *this* document from the first frame.
    lastCaret.current = null;
    const sel = view.state.selection.main;
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

  // Flipped in the Extensões modal with a file on screen: same in-place swap.
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

  // Closed tabs need not keep state (nor the text that came with it).
  const openDocs = useEditor((s) => s.docs.map((d) => d.id).join("\n"));
  useEffect(() => {
    const aliveCount = new Set(openDocs.split("\n"));
    for (const key of statesRef.current.keys()) {
      if (!aliveCount.has(key)) {
        statesRef.current.delete(key);
        dropHeadText(key);
      }
    }
  }, [openDocs]);

  return (
    <div
      className={`editor-surface ${readOnly ? "is-readonly" : ""}`}
      ref={hostRef}
    />
  );
}
