/**
 * The right pane: one note, in the same markdown vocabulary the file editor
 * speaks — the four modes (drawn, source, split, page), the formatting bar,
 * the fences with Mermaid and KaTeX, the checkbox that flips its source line.
 *
 * What is different from a file is the head: a note has no path, it has a
 * title, a notebook, a status and labels — so the head is those, editable in
 * place. And it has no "save": the buffer *is* the note, written on a
 * debounce by the store; closing the view loses nothing.
 *
 * A trashed note opens as the page, read-only, under a banner with the two
 * ways out (restore, delete for good) — editing the trash would be quicksand.
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  BookOpen,
  Code2,
  Columns2,
  Ellipsis,
  NotebookPen,
  Pencil,
  Pin,
  RotateCcw,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";

import { noteAsMarkdown } from "./NoteList";
import { loadLanguage } from "../CodeEditor/cm";
import { MarkdownPreview } from "../CodeEditor/MarkdownPreview";
import { MarkdownToolbar } from "../CodeEditor/MarkdownToolbar";
import type { MdBarSlots } from "../CodeEditor/chrome";
import { mdKeymap, runMd } from "../CodeEditor/mdCommands";
import { mdLive } from "../CodeEditor/mdLive";
import { syntaxFor } from "../CodeEditor/schemeSyntax";
import { openReplacePanel, yardSearch } from "../CodeEditor/searchPanel";
import { observeVisibleLine } from "../CodeEditor/surfaceCore";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { captureTextTarget, textMenuEntries } from "../../lib/textMenu";
import { Select } from "../Select";
import { useMarkdownNavigation } from "../../hooks/useMarkdownNavigation";
import { SCHEME_IDS } from "../../lib/colorSchemes";
import type { ExtensionId } from "../../lib/extensions";
import { ipc } from "../../lib/ipc";
import { LruCache } from "../../lib/lru";
import { openWebAddress } from "../../lib/openLink";
import { stats } from "../../lib/mddoc";
import { blockOf, type BlockKind } from "../../lib/mdedit";
import {
  childrenOf,
  fallbackTitle,
  notebookPath,
  STATUS_META,
  STATUSES,
  whenLabel,
  type Note,
} from "../../lib/notes";
import { useExtensions } from "../../stores/extensionsStore";
import { notesOverlayVisible, useNotes, type NotesMdMode } from "../../stores/notesStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";
import { locale, t } from "../../lib/i18n";

/**
 * The note's bar is formatting only: the four ways of looking at the markdown
 * sit on its meta row, beside the pin, and not inside the capsule the way the
 * file editor's do.
 */
const NOTE_BAR: MdBarSlots = { bar: true, formatting: true, modes: false };

// i18n-scan: tables
const MODES: { mode: NotesMdMode; icon: React.ReactNode; label: string; hint: string }[] = [
  { mode: "live", icon: <Pencil size={14} />, label: "Editar", hint: "escreve markdown já desenhado" },
  { mode: "source", icon: <Code2 size={14} />, label: "Fonte", hint: "o texto cru" },
  { mode: "split", icon: <Columns2 size={14} />, label: "Dividido", hint: "fonte de um lado, página do outro" },
  { mode: "read", icon: <BookOpen size={14} />, label: "Ler", hint: "só a página" },
];

export function NoteEditor() {
  const note = useNotes((s) =>
    s.activeId ? (s.notes.find((n) => n.id === s.activeId) ?? null) : null,
  );

  if (!note) return <EditorEmpty />;
  return <OpenNote key={note.id} note={note} />;
}

function EditorEmpty() {
  const t = useT();
  return (
    <div className="notes-editor-empty">
      <NotebookPen size={26} aria-hidden="true" />
      <p>{t("Nenhuma nota aberta")}</p>
      <p className="notes-empty-hint">
        <kbd>↑</kbd>
        <kbd>↓</kbd> {t("percorrem a lista")} · <kbd>Ctrl</kbd>+<kbd>N</kbd> {t("cria uma nova")}
      </p>
    </div>
  );
}

function OpenNote({ note }: { note: Note }) {
  const notebooks = useNotes((s) => s.notebooks);
  const mdMode = useNotes((s) => s.mdMode);
  const wantsFocus = useNotes((s) => s.wantsFocus);
  const showToast = useUI((s) => s.showToast);
  const t = useT();

  const inTrash = note.deletedAt !== null;
  const mode: NotesMdMode = inTrash ? "read" : mdMode;

  const titleRef = useRef<HTMLInputElement>(null);
  const viewHolder = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(
    null,
  );
  const [caret, setCaret] = useState<{ line: number; block: BlockKind }>({
    line: 0,
    block: "paragraph",
  });

  useEffect(() => {
    if (wantsFocus === "title") {
      titleRef.current?.focus();
      useNotes.getState().clearFocus();
    } else if (wantsFocus === "body") {
      viewHolder.current?.focus();
      useNotes.getState().clearFocus();
    }
  }, [wantsFocus]);

  // The page keeps up with the typing one beat behind — letters land first.
  const previewText = useDeferredValue(note.body);
  const counts = useMemo(() => stats(previewText), [previewText]);

  const isSplit = useCallback(() => useNotes.getState().mdMode === "split", []);
  const { goToLine, onCaret, onScrollLine } = useMarkdownNavigation({
    previewRef,
    viewRef: viewHolder,
    isSplit,
    setCaret,
  });

  // Stable handlers — the memoized preview bails out on identity.
  const noteId = note.id;
  const onTask = useCallback(
    (line: number) => useNotes.getState().toggleNoteTask(noteId, line),
    [noteId],
  );
  /**
   * A web address becomes a portal on the canvas — the same destination the
   * file editor already gave. It used to go to `open_external`, which only
   * accepts a path that exists on disk, so every link in a note answered
   * "esse arquivo não está mais no disco". The notebook sheet steps aside so
   * the portal shows up where it landed, as the editor does.
   */
  const onOpenUrl = useCallback((href: string) => {
    if (!openWebAddress(href)) {
      useUI.getState().showToast(t("Não sei abrir “{href}”.", { href }), "error");
      return;
    }
    if (notesOverlayVisible()) useNotes.getState().closeView();
  }, []);
  const onOpenPath = useCallback(() => {
    useUI
      .getState()
      .showToast(t("Links de arquivo valem nos documentos do projeto — aqui, use endereços da web."));
  }, []);

  const copy = () => {
    void navigator.clipboard
      .writeText(noteAsMarkdown(note))
      .then(() => showToast(t("Markdown copiado.")))
      .catch(() => showToast(t("Não consegui copiar."), "error"));
  };

  const exportIt = () => {
    const itemName = (note.title.trim() || fallbackTitle(note.body))
      .replace(/[\\/:*?"<>|]/g, "-")
      .slice(0, 60)
      .trim();
    void save({
      defaultPath: `${itemName || t("nota")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    }).then((dest) => {
      if (!dest) return;
      void ipc
        .noteExport(dest, noteAsMarkdown(note))
        .then(() => showToast(t("Nota exportada.")))
        .catch((e) => showToast(String(e), "error"));
    });
  };

  const deleteForever = () => {
    void ask(
      t('Excluir "{title}" de vez? Isso não tem volta.', { title: note.title.trim() || fallbackTitle(note.body) }),
      { title: t("Excluir a nota?"), kind: "warning" },
    ).then((yes) => {
      if (yes) useNotes.getState().deleteForever(note.id);
    });
  };

  const noneLabel = t("Sem caderno");
  const notebookOptions = useMemo(() => {
    const out = [{ value: "", label: noneLabel }];
    const listChildren = (parentId: string | null) => {
      for (const nb of childrenOf(notebooks, parentId)) {
        out.push({ value: nb.id, label: notebookPath(notebooks, nb.id) });
        listChildren(nb.id);
      }
    };
    listChildren(null);
    return out;
  }, [notebooks, noneLabel]);

  /**
   * What can be done with the whole note — the "Mais ações" kebab and the
   * right click anywhere in the editor show exactly this. Two doors, one
   * list: diverging here is how one of them falls behind.
   */
  const noteActions = (): MenuEntry[] => [
    {
      id: "duplicar",
      label: t("Duplicar"),
      disabled: inTrash,
      onSelect: () => useNotes.getState().duplicateNote(note.id),
    },
    { id: "copiar", label: t("Copiar como markdown"), onSelect: copy },
    { id: "exportar", label: t("Exportar .md…"), onSelect: exportIt },
    { kind: "sep" },
    inTrash
      ? { id: "excluir", label: t("Excluir de vez"), danger: true, onSelect: deleteForever }
      : {
          id: "lixeira",
          label: t("Mover para a lixeira"),
          danger: true,
          onSelect: () => useNotes.getState().trashNote(note.id),
        },
  ];

  /**
   * Right click in the editor: the text first (it is a writing surface —
   * taking "paste" away from someone to give them a menu would be a bad
   * deal), then the note. `captureTextTarget` has to run now, before the
   * menu opens and takes the focus away.
   */
  const openEditorMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = captureTextTarget(e.nativeEvent);
    const theText = textMenuEntries(target, { app: false });
    setMenu({
      anchor: { x: e.clientX, y: e.clientY },
      entries: theText.length > 0 ? [...theText, { kind: "sep" }, ...noteActions()] : noteActions(),
    });
  };

  return (
    <div className="notes-editor" onContextMenu={openEditorMenu}>
      {inTrash && (
        <div className="notes-trashbar" role="alert">
          <Trash2 size={13} aria-hidden="true" />
          <span>{t("Esta nota está na lixeira — leitura apenas.")}</span>
          <button
            className="btn btn--sm"
            onClick={() => useNotes.getState().restoreNote(note.id)}
          >
            <RotateCcw size={12} aria-hidden="true" /> {t("Restaurar")}
          </button>
          <button className="btn btn--sm btn--danger" onClick={deleteForever}>
            {t("Excluir de vez")}
          </button>
        </div>
      )}

      <div className="notes-head">
        <input
          ref={titleRef}
          className="notes-title"
          value={note.title}
          placeholder={t("Sem título")}
          aria-label={t("Título da nota")}
          spellCheck={false}
          disabled={inTrash}
          onChange={(e) => useNotes.getState().updateNote(note.id, { title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              viewHolder.current?.focus();
            }
          }}
        />
        <div className="notes-meta">
          <Select
            className="notes-meta-book"
            value={note.notebookId ?? ""}
            label={t("Caderno da nota")}
            tip={t("Caderno")}
            options={notebookOptions}
            disabled={inTrash}
            onChange={(v) => useNotes.getState().setNoteBook(note.id, v || null)}
          />
          <Select
            className="notes-meta-status"
            value={note.status}
            label={t("Status da nota")}
            tip={t("Status — trate a nota como tarefa")}
            options={STATUSES.map((s) => ({ value: s, label: t(STATUS_META[s].label) }))}
            disabled={inTrash}
            onChange={(v) => useNotes.getState().setNoteStatus(note.id, v as Note["status"])}
          />
          <button
            className={`icon-btn ${note.pinned ? "is-active" : ""}`}
            data-tip={note.pinned ? t("Desafixar do topo") : t("Fixar no topo da lista")}
            aria-label={note.pinned ? t("Desafixar do topo") : t("Fixar no topo")}
            aria-pressed={note.pinned}
            disabled={inTrash}
            onClick={() => useNotes.getState().togglePin(note.id)}
          >
            <Pin size={14} />
          </button>
          <button
            className="icon-btn"
            data-tip={t("Mais ações")}
            aria-label={t("Mais ações da nota")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ anchor: { x: r.left, y: r.bottom + 4 }, entries: noteActions() });
            }}
          >
            <Ellipsis size={14} />
          </button>
          <span className="notes-meta-gap" />
          {!inTrash && (
            <div className="md-modes" role="group" aria-label={t("Como mostrar o markdown")}>
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  className={`icon-btn ${mode === m.mode ? "is-active" : ""}`}
                  data-tip={`${t(m.label)} — ${t(m.hint)}`}
                  aria-label={t(m.label)}
                  aria-pressed={mode === m.mode}
                  onClick={() => useNotes.getState().setMdMode(m.mode)}
                >
                  {m.icon}
                </button>
              ))}
            </div>
          )}
        </div>
        {!inTrash && <TagsField note={note} />}
      </div>

      {!inTrash && mode !== "read" && (
        <MarkdownToolbar
          block={caret.block}
          run={(cmd) => runMd(viewHolder.current, cmd)}
          slots={NOTE_BAR}
        />
      )}

      <div className={`editor-panes is-md is-${mode} notes-panes`}>
        {mode !== "read" && (
          <NoteSurface
            noteId={note.id}
            body={note.body}
            live={mode === "live" || mode === "split"}
            onCaret={onCaret}
            onScrollLine={onScrollLine}
            viewHolder={viewHolder}
          />
        )}
        {(mode === "split" || mode === "read") && (
          <div className="editor-preview notes-preview" ref={previewRef} tabIndex={0}>
            <MarkdownPreview
              text={previewText}
              root=""
              path="anotacao.md"
              onTask={inTrash ? noop : onTask}
              onOpenPath={onOpenPath}
              onOpenUrl={onOpenUrl}
              onGoToLine={mode === "split" ? goToLine : undefined}
            />
          </div>
        )}
      </div>

      <footer className="notes-foot">
        <span className="notes-foot-left">
          {counts.tasks.total > 0 && (
            <span data-tip={t("Tarefas concluídas nesta nota")}>
              {t("{done}/{total} tarefas", { done: counts.tasks.done, total: counts.tasks.total })}
            </span>
          )}
          <span data-tip={t("{n} caracteres", { n: counts.chars })}>{t("{n} palavras", { n: counts.words })}</span>
          <span data-tip={t("Tempo de leitura, a 200 palavras por minuto")}>
            {counts.minutes} min
          </span>
        </span>
        <span className="notes-foot-right">
          <span data-tip={new Date(note.createdAt).toLocaleString(locale())}>
            {t("criada {when}", { when: whenLabel(note.createdAt) })}
          </span>
          <span data-tip={new Date(note.updatedAt).toLocaleString(locale())}>
            {t("editada {when}", { when: whenLabel(note.updatedAt) })}
          </span>
        </span>
      </footer>

      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          items={menu.entries}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function noop() {}

// ---------------------------------------------------------------------------
// labels — chips plus a field with suggestions
// ---------------------------------------------------------------------------

function TagsField({ note }: { note: Note }) {
  const tags = useNotes((s) => s.tags);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  const noteTags = note.tags
    .map((id) => tags.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t);

  const suggestions = useMemo(() => {
    const typed = text.trim().toLowerCase();
    const outside = tags.filter((t) => !note.tags.includes(t.id));
    const list = typed
      ? outside.filter((t) => t.name.toLowerCase().includes(typed))
      : outside;
    return list.slice(0, 6);
  }, [text, tags, note.tags]);

  const createNew =
    text.trim().length > 0 &&
    !tags.some((t) => t.name.toLowerCase() === text.trim().toLowerCase());
  const isOpen = text.trim().length > 0 && (suggestions.length > 0 || createNew);
  const totalOptions = suggestions.length + (createNew ? 1 : 0);

  const apply = (tagId: string | null) => {
    const id = tagId ?? useNotes.getState().ensureTag(text);
    if (id && !note.tags.includes(id)) {
      useNotes.getState().setNoteTags(note.id, [...note.tags, id]);
    }
    setText("");
    setCursor(0);
    inputRef.current?.focus();
  };

  const remove = (id: string) => {
    useNotes.getState().setNoteTags(
      note.id,
      note.tags.filter((t) => t !== id),
    );
  };

  return (
    <div className="notes-tags">
      <TagIcon size={12} className="notes-tags-icon" aria-hidden="true" />
      {noteTags.map((tag) => (
        <span key={tag.id} className="notes-chip">
          <span className="notes-dot" style={{ background: tag.color }} />
          {tag.name}
          <button
            className="notes-chip-x"
            aria-label={t("Tirar a etiqueta {name}", { name: tag.name })}
            onClick={() => remove(tag.id)}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <div className="notes-tags-entry">
        <input
          ref={inputRef}
          value={text}
          placeholder={noteTags.length === 0 ? t("adicionar etiqueta…") : ""}
          aria-label={t("Adicionar etiqueta")}
          role="combobox"
          aria-expanded={isOpen}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isOpen) {
              e.preventDefault();
              if (cursor < suggestions.length) apply(suggestions[cursor].id);
              else apply(null);
            } else if (e.key === "ArrowDown" && isOpen) {
              e.preventDefault();
              setCursor((c) => (c + 1) % totalOptions);
            } else if (e.key === "ArrowUp" && isOpen) {
              e.preventDefault();
              setCursor((c) => (c - 1 + totalOptions) % totalOptions);
            } else if (e.key === "Escape" && text) {
              e.preventDefault();
              e.stopPropagation();
              setText("");
            } else if (e.key === "Backspace" && !text && note.tags.length > 0) {
              remove(note.tags[note.tags.length - 1]);
            }
          }}
        />
        {isOpen && (
          <div className="notes-tags-pop" role="listbox" aria-label={t("Etiquetas sugeridas")}>
            {suggestions.map((tag, i) => (
              <button
                key={tag.id}
                role="option"
                aria-selected={i === cursor}
                className={i === cursor ? "is-active" : ""}
                onMouseEnter={() => setCursor(i)}
                // Before the input's blur — a click must not lose what was typed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  apply(tag.id);
                }}
              >
                <span className="notes-dot" style={{ background: tag.color }} />
                {tag.name}
              </button>
            ))}
            {createNew && (
              <button
                role="option"
                aria-selected={cursor === suggestions.length}
                className={cursor === suggestions.length ? "is-active" : ""}
                onMouseEnter={() => setCursor(suggestions.length)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  apply(null);
                }}
              >
                {t("criar “{name}”", { name: text.trim() })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the CodeMirror host — the file editor's engine, minus files
// ---------------------------------------------------------------------------

const IMG_PASTE_MAX = 1_500_000;

/**
 * Editor state per note, so switching notes keeps undo, caret and scroll.
 * Only one surface exists at a time, which is what lets the compartments be
 * module singletons — a restored state must answer to the same compartment
 * instances, or `reconfigure` after a restore falls on deaf ears.
 */
const stored = new LruCache<string, EditorState>(40);
const languageComp = new Compartment();
const liveComp = new Compartment();
const syntaxComp = new Compartment();

function NoteSurface({
  noteId,
  body,
  live,
  onCaret,
  onScrollLine,
  viewHolder,
}: {
  noteId: string;
  body: string;
  live: boolean;
  onCaret: (at: { line: number; block: BlockKind }) => void;
  onScrollLine: (line: number) => void;
  viewHolder: React.MutableRefObject<EditorView | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Last text this surface itself published — tells edits apart from echoes. */
  const published = useRef<string | null>(null);
  const caretRef = useRef(onCaret);
  caretRef.current = onCaret;
  const scrollRef = useRef(onScrollLine);
  scrollRef.current = onScrollLine;
  const lastCaret = useRef<{ line: number; block: BlockKind } | null>(null);

  const schemeId = useExtensions((s) =>
    SCHEME_IDS.find((id) => s.enabled[id as ExtensionId] === true),
  );

  const makeState = useCallback(
    (id: string, text: string) =>
      EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          // The same search bar as the file editor, at the top and with the
          // match counter.
          yardSearch,
          syntaxComp.of(syntaxFor(schemeId)),
          EditorView.lineWrapping,
          languageComp.of([]),
          liveComp.of(live ? mdLive : []),
          mdKeymap,
          Prec.high(
            keymap.of([
              indentWithTab,
              { key: "Mod-h", run: openReplacePanel, preventDefault: true },
              {
                key: "Mod-s",
                preventDefault: true,
                // There is no "save": the text already is the note. The gesture
                // only brings the pending write forward, for the hand that
                // insists on Ctrl+S.
                run: () => {
                  useNotes.getState().flush();
                  return true;
                },
              },
            ]),
          ),
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const items = event.clipboardData?.items;
              if (!items) return false;
              const file = [...items]
                .find((i) => i.kind === "file" && i.type.startsWith("image/"))
                ?.getAsFile();
              if (!file) return false;
              event.preventDefault();
              if (file.size > IMG_PASTE_MAX) {
                useUI
                  .getState()
                  .showToast(t("Imagem grande demais para colar aqui (máx. 1,5 MB)."), "error");
                return true;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const url = String(reader.result ?? "");
                if (!url.startsWith("data:image/")) return;
                const sel = view.state.selection.main;
                view.dispatch({
                  changes: { from: sel.from, to: sel.to, insert: `![imagem](${url})` }, // i18n-ok
                  selection: EditorSelection.cursor(sel.from + 2),
                  userEvent: "input.paste",
                });
              };
              reader.readAsDataURL(file);
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const texto2 = u.state.doc.toString();
              published.current = texto2;
              useNotes.getState().updateNote(id, { body: texto2 });
            }
            if (u.docChanged || u.selectionSet) {
              const sel = u.state.selection.main;
              const row = u.state.doc.lineAt(sel.head);
              const at = {
                line: row.number - 1,
                block: blockOf(u.state.doc.toString(), sel.head),
              };
              const before = lastCaret.current;
              if (!before || before.line !== at.line || before.block !== at.block) {
                lastCaret.current = at;
                caretRef.current(at);
              }
            }
          }),
        ],
      }),
    [live, schemeId],
  );

  // Mounts once; switching notes swaps the state, never the view.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: stored.get(noteId) ?? makeState(noteId, body),
      parent: host,
    });
    viewRef.current = view;
    viewHolder.current = view;
    void loadLanguage("anotacao.md").then((ext) => {
      if (viewRef.current === view && ext) {
        view.dispatch({ effects: languageComp.reconfigure(ext) });
      }
    });

    const stopScroll = observeVisibleLine(view, () => scrollRef.current);

    return () => {
      stopScroll();
      stored.set(noteId, view.state);
      view.destroy();
      viewRef.current = null;
      viewHolder.current = null;
    };
    // One mount per note — the component is keyed by the note upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The body changed from outside the surface (checkbox in the preview,
  // restore, another pane): push it in without losing the caret.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (body === published.current) return;
    const currentValue = view.state.doc.toString();
    if (body === currentValue) return;
    published.current = body;
    const sel = Math.min(view.state.selection.main.head, body.length);
    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: body },
      selection: EditorSelection.cursor(sel),
    });
  }, [body]);

  // Mode and color-scheme switches reconfigure in place.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        liveComp.reconfigure(live ? mdLive : []),
        syntaxComp.reconfigure(syntaxFor(schemeId)),
      ],
    });
  }, [live, schemeId]);

  return <div className="editor-surface notes-surface" ref={hostRef} />;
}
