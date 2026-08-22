/**
 * The middle pane: the notes of the current collection, searchable and in
 * final reading order (pinned first).
 *
 * The search box understands qualifiers (`caderno:`, `tag:`, `status:`,
 * `titulo:`, aspas, `-`) and the hits light up in the titles and previews —
 * the row itself answers "why did this match". Every structural action a row
 * offers (pin, status, move, duplicate, export, trash) lives in its context
 * menu; the list keeps the surface clean for scanning.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, ListChecks, Pin, Search, X } from "lucide-react";

import { useVisibleNotes } from "./index";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { Select } from "../Select";
import { notesListMenu, type NotesMenuActions } from "../../lib/notesMenu";
import { captureTextTarget } from "../../lib/textMenu";
import { ipc } from "../../lib/ipc";
import {
  childrenOf,
  fallbackTitle,
  fold,
  notebookPath,
  parseNotesQuery,
  snippetFor,
  STATUS_META,
  STATUSES,
  taskProgress,
  whenLabel,
  type Note,
  type NoteSort,
  type NotesQuery,
} from "../../lib/notes";
import { useNotes } from "../../stores/notesStore";
import { useUI } from "../../stores/uiStore";

const SORT_LABEL: Record<NoteSort, string> = {
  updated: "Última edição",
  created: "Criação",
  title: "Título",
};

/** `# Título` + body — the note as one portable markdown document. */
export function noteAsMarkdown(note: Note): string {
  const theTitle = note.title.trim();
  if (!theTitle) return note.body;
  return `# ${theTitle}\n\n${note.body}`;
}

function exportName(note: Note): string {
  const base = (note.title.trim() || fallbackTitle(note.body))
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 60)
    .trim();
  return `${base || "nota"}.md`;
}

/** Paints `texto` with the query's positive terms lit as `.notes-hit`. */
function withHits(theText: string, terms: readonly string[]): ReactNode {
  if (terms.length === 0 || !theText) return theText;
  const base = fold(theText);
  const spans: [number, number][] = [];
  for (const t of terms) {
    let at = base.indexOf(t);
    let fuse = 0;
    while (at >= 0 && fuse < 20) {
      spans.push([at, at + t.length]);
      at = base.indexOf(t, at + 1);
      fuse += 1;
    }
  }
  if (spans.length === 0) return theText;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of spans) {
    const lastOne = merged[merged.length - 1];
    if (lastOne && s <= lastOne[1]) lastOne[1] = Math.max(lastOne[1], e);
    else merged.push([s, e]);
  }
  const out: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([s, e], i) => {
    if (s > cursor) out.push(theText.slice(cursor, s));
    out.push(
      <mark key={i} className="notes-hit">
        {theText.slice(s, e)}
      </mark>,
    );
    cursor = e;
  });
  if (cursor < theText.length) out.push(theText.slice(cursor));
  return out;
}

export function NoteList() {
  const notes = useVisibleNotes();
  const notebooks = useNotes((s) => s.notebooks);
  const tags = useNotes((s) => s.tags);
  const collection = useNotes((s) => s.collection);
  const activeId = useNotes((s) => s.activeId);
  const query = useNotes((s) => s.query);
  const sort = useNotes((s) => s.sort);
  const showResolved = useNotes((s) => s.showResolved);
  const wantsFocus = useNotes((s) => s.wantsFocus);
  const totalNotes = useNotes((s) => s.notes.length);
  const showToast = useUI((s) => s.showToast);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<
    { anchor: MenuAnchor; note: Note } | { anchor: MenuAnchor; entries: MenuEntry[] } | null
  >(null);

  const q = useMemo(() => parseNotesQuery(query), [query]);
  const terms = useMemo(
    () => [...q.terms, ...q.titles].filter((t) => !t.not).map((t) => t.text),
    [q],
  );
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  useEffect(() => {
    if (wantsFocus === "search") {
      searchRef.current?.focus();
      searchRef.current?.select();
      useNotes.getState().clearFocus();
    }
  }, [wantsFocus]);

  // The selected row follows into view when the keyboard moves it.
  useEffect(() => {
    if (!activeId) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const inTrash = collection.kind === "trash";

  const title = (() => {
    if (collection.kind === "all") return "Todas as notas";
    if (collection.kind === "trash") return "Lixeira";
    if (collection.kind === "status") {
      const meta = STATUS_META[collection.status];
      return collection.status === "paused" ? "Em espera" : `${meta.label}s`;
    }
    if (collection.kind === "book") {
      return notebookPath(notebooks, collection.id) || "Caderno";
    }
    return tagById.get(collection.id)?.name ?? "Etiqueta";
  })();

  /** Who gets the seat when this note leaves the list. */
  const nextAfter = (id: string): string | null => {
    const i = notes.findIndex((n) => n.id === id);
    if (i < 0) return activeId;
    return notes[i + 1]?.id ?? notes[i - 1]?.id ?? null;
  };

  const remove = (note: Note) => {
    if (note.deletedAt === null) {
      const following = nextAfter(note.id);
      useNotes.getState().trashNote(note.id);
      if (activeId === note.id) useNotes.getState().setActive(following);
      return;
    }
    void ask(`Excluir "${note.title.trim() || fallbackTitle(note.body)}" de vez? Isso não tem volta.`, {
      title: "Excluir a nota?",
      kind: "warning",
    }).then((yes) => {
      if (!yes) return;
      const fresh = nextAfter(note.id);
      useNotes.getState().deleteForever(note.id);
      useNotes.getState().setActive(fresh);
    });
  };

  const copy = (note: Note) => {
    void navigator.clipboard
      .writeText(noteAsMarkdown(note))
      .then(() => showToast("Markdown copiado."))
      .catch(() => showToast("Não consegui copiar.", "error"));
  };

  const exportIt = (note: Note) => {
    void save({
      defaultPath: exportName(note),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    }).then((dest) => {
      if (!dest) return;
      void ipc
        .noteExport(dest, noteAsMarkdown(note))
        .then(() => showToast("Nota exportada."))
        .catch((e) => showToast(String(e), "error"));
    });
  };

  const noteMenu = (note: Note): MenuEntry[] => {
    if (note.deletedAt !== null) {
      return [
        {
          id: "restaurar",
          label: "Restaurar",
          onSelect: () => useNotes.getState().restoreNote(note.id),
        },
        { kind: "sep" },
        { id: "excluir", label: "Excluir de vez", danger: true, onSelect: () => remove(note) },
      ];
    }
    // Every notebook as a flat path list — nesting reads as "Pai / Filho".
    const destinations: MenuEntry[] = [
      {
        id: "sem-caderno",
        label: "Sem caderno",
        checked: note.notebookId === null,
        onSelect: () => useNotes.getState().setNoteBook(note.id, null),
      },
    ];
    const listChildren = (parentId: string | null) => {
      for (const nb of childrenOf(notebooks, parentId)) {
        destinations.push({
          id: `mover-${nb.id}`,
          label: notebookPath(notebooks, nb.id),
          checked: note.notebookId === nb.id,
          onSelect: () => useNotes.getState().setNoteBook(note.id, nb.id),
        });
        listChildren(nb.id);
      }
    };
    listChildren(null);

    return [
      {
        id: "fixar",
        label: note.pinned ? "Desafixar do topo" : "Fixar no topo",
        onSelect: () => useNotes.getState().togglePin(note.id),
      },
      {
        id: "status",
        label: "Status",
        submenu: STATUSES.map((s) => ({
          id: `status-${s}`,
          label: STATUS_META[s].label,
          checked: note.status === s,
          onSelect: () => useNotes.getState().setNoteStatus(note.id, s),
        })),
      },
      { id: "mover", label: "Mover para", submenu: destinations },
      { kind: "sep" },
      {
        id: "duplicar",
        label: "Duplicar",
        onSelect: () => useNotes.getState().duplicateNote(note.id),
      },
      { id: "copiar", label: "Copiar como markdown", onSelect: () => copy(note) },
      { id: "exportar", label: "Exportar .md…", onSelect: () => exportIt(note) },
      { kind: "sep" },
      {
        id: "lixeira",
        label: "Mover para a lixeira",
        danger: true,
        shortcut: "Delete",
        onSelect: () => remove(note),
      },
    ];
  };

  /** What the pane's menu (bar and list background) can do. */
  const actions: NotesMenuActions = {
    select: (c) => useNotes.getState().select(c),
    createNote: () => useNotes.getState().createNote(),
    newNotebook: (parentId) => useNotes.getState().addNotebook("Novo caderno", parentId),
    setSort: (s) => useNotes.getState().setSort(s),
    setShowResolved: (v) => useNotes.getState().setShowResolved(v),
    clearQuery: () => useNotes.getState().setQuery(""),
    focusSearch: () => useNotes.getState().focusSearch(),
    setFolded: () => {},
    emptyTrash: () => {
      const count = useNotes.getState().notes.filter((n) => n.deletedAt !== null).length;
      void ask(`Excluir de vez ${count} nota(s) da lixeira? Isso não tem volta.`, {
        title: "Esvaziar a lixeira?",
        kind: "warning",
      }).then((yes) => {
        if (yes) useNotes.getState().emptyTrash();
      });
    },
  };

  const openPaneMenu = (e: React.MouseEvent) => {
    // In a text field the right menu is cut/paste: let it bubble up to the
    // global net instead of answering with the pane's menu.
    if (captureTextTarget(e.nativeEvent).info.editable) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      anchor: { x: e.clientX, y: e.clientY },
      entries: notesListMenu(
        collection,
        {
          sort,
          showResolved,
          query,
          trashCount: useNotes.getState().notes.filter((n) => n.deletedAt !== null).length,
          foldableCount: 0,
          allFolded: false,
        },
        actions,
      ),
    });
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (notes.length === 0) return;
    const i = notes.findIndex((n) => n.id === activeId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(i + 1, notes.length - 1) : Math.max(i - 1, 0);
      useNotes.getState().setActive(notes[next < 0 ? 0 : next].id);
    } else if (e.key === "Home") {
      e.preventDefault();
      useNotes.getState().setActive(notes[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      useNotes.getState().setActive(notes[notes.length - 1].id);
    } else if (e.key === "Delete" && activeId) {
      const note = notes.find((n) => n.id === activeId);
      if (note) {
        e.preventDefault();
        remove(note);
      }
    } else if (e.key === "Enter" && activeId) {
      e.preventDefault();
      useNotes.setState({ wantsFocus: "body" });
    }
  };

  return (
    // The whole pane answers the right click: the bar, the header and the
    // empty space below the last note. The rows stop propagation with their
    // own menu, and the search field lets it through to the global net
    // (cut/paste).
    <div className="notes-list" onContextMenu={openPaneMenu}>
      <div className="notes-list-bar">
        <div className="notes-search">
          <Search size={12} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            placeholder="Buscar — tag: caderno: status: -termo"
            aria-label="Buscar nas anotações"
            spellCheck={false}
            onChange={(e) => useNotes.getState().setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                useNotes.getState().setQuery("");
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                listRef.current?.focus();
              }
            }}
          />
          {query && (
            <button
              className="icon-btn icon-btn--xs"
              aria-label="Limpar a busca"
              onClick={() => {
                useNotes.getState().setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X size={11} />
            </button>
          )}
        </div>
        <div className="notes-list-sub">
          <span className="notes-list-title" data-tip-wrap="" data-tip={title}>
            {title}
            <span className="notes-list-count">
              {notes.length} {notes.length === 1 ? "nota" : "notas"}
            </span>
          </span>
          <span className="notes-list-tools">
            {!inTrash && collection.kind !== "status" && (
              <button
                className={`icon-btn icon-btn--xs ${showResolved ? "is-active" : ""}`}
                data-tip={
                  showResolved
                    ? "Esconder concluídas e descartadas"
                    : "Mostrar concluídas e descartadas"
                }
                aria-label="Mostrar ou esconder notas resolvidas"
                aria-pressed={showResolved}
                onClick={() => useNotes.getState().setShowResolved(!showResolved)}
              >
                {showResolved ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
            )}
            <Select
              className="notes-sort"
              value={sort}
              label="Ordenar por"
              tip="Ordenação da lista"
              options={(Object.keys(SORT_LABEL) as NoteSort[]).map((s) => ({
                value: s,
                label: SORT_LABEL[s],
              }))}
              onChange={(v) => useNotes.getState().setSort(v as NoteSort)}
            />
          </span>
        </div>
      </div>

      <div
        ref={listRef}
        className="notes-list-scroll"
        role="listbox"
        aria-label={`Notas — ${title}`}
        tabIndex={0}
        onKeyDown={onListKey}
      >
        {notes.length === 0 && <EmptyList query={query} trash={inTrash} total={totalNotes} />}
        {notes.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            active={note.id === activeId}
            q={q}
            terms={terms}
            tagById={tagById}
            onSelect={() => useNotes.getState().setActive(note.id)}
            onMenu={(anchor) => setMenu({ anchor, note })}
          />
        ))}
      </div>

      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          items={"note" in menu ? noteMenu(menu.note) : menu.entries}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function NoteRow({
  note,
  active,
  q,
  terms: terms,
  tagById,
  onSelect,
  onMenu,
}: {
  note: Note;
  active: boolean;
  q: NotesQuery;
  terms: readonly string[];
  tagById: Map<string, { name: string; color: string }>;
  onSelect: () => void;
  onMenu: (anchor: MenuAnchor) => void;
}) {
  const title = note.title.trim() || fallbackTitle(note.body);
  const snip = useMemo(() => snippetFor(note.body, q), [note.body, q]);
  const tasks = useMemo(() => taskProgress(note.body), [note.body]);
  const dot = STATUS_META[note.status].dot;
  const chips = note.tags
    .map((id) => tagById.get(id))
    .filter((t): t is { name: string; color: string } => !!t);

  return (
    <div
      className={`notes-item ${active ? "is-active" : ""}`}
      role="option"
      aria-selected={active}
      data-note-id={note.id}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="notes-item-top">
        {note.pinned && (
          <Pin size={11} className="notes-item-pin" aria-label="Fixada" />
        )}
        {dot && (
          <span
            className="notes-dot"
            style={{ background: dot }}
            data-tip={STATUS_META[note.status].label}
            aria-label={STATUS_META[note.status].label}
          />
        )}
        <span className="notes-item-title">{withHits(title, terms)}</span>
        <span className="notes-item-when" data-tip={new Date(note.updatedAt).toLocaleString("pt-BR")}>
          {whenLabel(note.updatedAt)}
        </span>
      </div>
      {snip.text && (
        <div className="notes-item-snippet">
          {snip.hits.length > 0 ? paintSnippet(snip.text, snip.hits) : snip.text}
        </div>
      )}
      {(tasks.total > 0 || chips.length > 0) && (
        <div className="notes-item-meta">
          {tasks.total > 0 && (
            <span
              className={`notes-tasks ${tasks.done === tasks.total ? "is-done" : ""}`}
              data-tip="Tarefas concluídas nesta nota"
              role="img"
              aria-label={`${tasks.done}/${tasks.total} tarefas concluídas`}
            >
              <ListChecks size={11} aria-hidden="true" />
              {tasks.done}/{tasks.total}
            </span>
          )}
          {chips.slice(0, 3).map((t) => (
            <span key={t.name} className="notes-chip">
              <span className="notes-dot" style={{ background: t.color }} />
              {t.name}
            </span>
          ))}
          {chips.length > 3 && (
            <span className="notes-chip notes-chip--more">+{chips.length - 3}</span>
          )}
        </div>
      )}
    </div>
  );
}

function paintSnippet(text: string, hits: [number, number][]): ReactNode {
  const out: ReactNode[] = [];
  let cursor = 0;
  hits.forEach(([s, e], i) => {
    if (s > cursor) out.push(text.slice(cursor, s));
    out.push(
      <mark key={i} className="notes-hit">
        {text.slice(s, e)}
      </mark>,
    );
    cursor = e;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function EmptyList({ query, trash, total }: { query: string; trash: boolean; total: number }) {
  if (trash) {
    return (
      <div className="notes-empty">
        <p>Lixeira vazia.</p>
        <p className="notes-empty-hint">
          Notas apagadas ficam aqui até você restaurar ou excluir de vez.
        </p>
      </div>
    );
  }
  if (query.trim()) {
    return (
      <div className="notes-empty">
        <p>Nada com esses termos.</p>
        <p className="notes-empty-hint">
          Refine com <code>caderno:</code>, <code>tag:</code>, <code>status:</code>,{" "}
          <code>titulo:</code>, frases entre aspas e <code>-termo</code> para excluir.
        </p>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="notes-empty">
        <p>Seu caderno começa aqui.</p>
        <p className="notes-empty-hint">
          <kbd>Ctrl</kbd>+<kbd>N</kbd> cria a primeira nota — markdown completo, com
          código, tarefas, tabelas, Mermaid e fórmulas.
        </p>
      </div>
    );
  }
  return (
    <div className="notes-empty">
      <p>Nenhuma nota nesta coleção.</p>
      <p className="notes-empty-hint">
        Crie uma com <kbd>Ctrl</kbd>+<kbd>N</kbd> — ela já nasce aqui.
      </p>
    </div>
  );
}
