/**
 * The rail — where the notebook is organized: the everyday collections on
 * top, the notebook tree, the labels, and the trash at the bottom.
 *
 * Counts ride every row (a notebook counts its whole branch) because the rail
 * is also the notebook's dashboard: "12 ativas" says more than any icon.
 * Structure edits happen right here — context menus with rename-in-place —
 * so organizing never needs a settings screen.
 */
import { useMemo, useState, type ReactNode } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Library,
  Plus,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { InlineRename } from "../ContextMenu/InlineRename";
import {
  notesRailBackgroundMenu,
  notesRailRowMenu,
  type NotesMenuActions,
  type NotesMenuContext,
} from "../../lib/notesMenu";
import {
  childrenOf,
  railCounts,
  STATUS_META,
  TAG_COLORS,
  type Collection,
  type Notebook,
  type NoteStatus,
} from "../../lib/notes";
import { useNotes } from "../../stores/notesStore";
import { useT } from "../../hooks/useT";

// i18n-scan: tables

/** Curated notebook glyphs — enough to tell shelves apart, few enough to pick fast. */
const ICONS = ["📓", "💡", "🧭", "🐛", "🧪", "📚", "🗂️", "⭐", "🔧", "🏠"];

const STATUS_ROWS: NoteStatus[] = ["active", "paused", "done", "dropped"];

/** The rail speaks in the plural; "Em espera" already is one. */
const STATUS_PLURAL: Record<NoteStatus, string> = {
  none: "Sem status",
  active: "Ativas",
  paused: "Em espera",
  done: "Concluídas",
  dropped: "Descartadas",
};

function sameCollection(a: Collection, b: Collection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "book" && b.kind === "book") return a.id === b.id;
  if (a.kind === "tag" && b.kind === "tag") return a.id === b.id;
  if (a.kind === "status" && b.kind === "status") return a.status === b.status;
  return true;
}

export function NotesRail() {
  const notes = useNotes((s) => s.notes);
  const notebooks = useNotes((s) => s.notebooks);
  const tags = useNotes((s) => s.tags);
  const collection = useNotes((s) => s.collection);
  const sort = useNotes((s) => s.sort);
  const showResolved = useNotes((s) => s.showResolved);
  const query = useNotes((s) => s.query);
  const t = useT();

  const counts = useMemo(() => railCounts(notes, notebooks), [notes, notebooks]);

  /** Branches folded shut — the default is everything open. */
  const [closed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(
    null,
  );

  const select = (c: Collection) => useNotes.getState().select(c);

  const openMenu = (e: React.MouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, entries });
  };

  /** Notebooks that have a child — the only ones "recolher tudo" reaches. */
  const foldable = useMemo(
    () => notebooks.filter((nb) => notebooks.some((o) => o.parentId === nb.id)),
    [notebooks],
  );
  const allClosed =
    foldable.length > 0 && foldable.every((nb) => closed.has(nb.id));

  const askEmptyTrash = () => {
    void ask(
      t("Excluir de vez {n} nota(s) da lixeira? Isso não tem volta.", { n: counts.trash }),
      { title: t("Esvaziar a lixeira?"), kind: "warning" },
    ).then((yes) => {
      if (yes) useNotes.getState().emptyTrash();
    });
  };

  const actions: NotesMenuActions = {
    select,
    createNote: () => useNotes.getState().createNote(),
    newNotebook: (parentId) => newNotebook(parentId),
    setSort: (s) => useNotes.getState().setSort(s),
    setShowResolved: (v) => useNotes.getState().setShowResolved(v),
    clearQuery: () => useNotes.getState().setQuery(""),
    focusSearch: () => useNotes.getState().focusSearch(),
    setFolded: (folded) =>
      setCollapsed(folded ? new Set(foldable.map((nb) => nb.id)) : new Set()),
    emptyTrash: askEmptyTrash,
  };

  const ctxMenu: NotesMenuContext = {
    sort,
    showResolved,
    query,
    trashCount: counts.trash,
    foldableCount: foldable.length,
    allFolded: allClosed,
  };

  // --- rows -----------------------------------------------------------------

  const row = (opts: {
    key: string;
    label: string;
    icon: ReactNode;
    count?: number;
    active: boolean;
    depth?: number;
    chevron?: "open" | "closed" | null;
    onChevron?: () => void;
    onClick: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    renaming?: { value: string; onCommit: (v: string) => void } | null;
  }) => (
    <div
      key={opts.key}
      className={`notes-row ${opts.active ? "is-active" : ""}`}
      style={opts.depth ? { paddingLeft: 8 + opts.depth * 14 } : undefined}
      onContextMenu={opts.onContextMenu}
    >
      {opts.chevron !== undefined && opts.chevron !== null ? (
        <button
          className="notes-row-chevron"
          aria-label={opts.chevron === "open" ? t("Recolher") : t("Expandir")}
          aria-expanded={opts.chevron === "open"}
          onClick={(e) => {
            e.stopPropagation();
            opts.onChevron?.();
          }}
        >
          {opts.chevron === "open" ? (
            <ChevronDown size={11} />
          ) : (
            <ChevronRight size={11} />
          )}
        </button>
      ) : (
        <span className="notes-row-chevron notes-row-chevron--empty" aria-hidden="true" />
      )}
      <button
        className="notes-row-main"
        aria-current={opts.active ? "true" : undefined}
        onClick={opts.onClick}
      >
        <span className="notes-row-icon" aria-hidden="true">
          {opts.icon}
        </span>
        {opts.renaming ? (
          <InlineRename
            value={opts.renaming.value}
            onCommit={(v) => {
              opts.renaming?.onCommit(v);
              setRenaming(null);
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <span className="notes-row-label">{opts.label}</span>
        )}
        {opts.count !== undefined && opts.count > 0 && (
          <span className="notes-row-count">{opts.count}</span>
        )}
      </button>
    </div>
  );

  // --- notebooks ------------------------------------------------------------

  const newNotebook = (parentId: string | null) => {
    const id = useNotes.getState().addNotebook(t("Novo caderno"), parentId);
    if (parentId) {
      setCollapsed((s) => {
        const next = new Set(s);
        next.delete(parentId);
        return next;
      });
    }
    setRenaming(id);
  };

  const notebookMenu = (nb: Notebook): MenuEntry[] => [
    {
      id: "nova-nota",
      label: t("Nova nota aqui"),
      onSelect: () => {
        select({ kind: "book", id: nb.id });
        useNotes.getState().createNote();
      },
    },
    {
      id: "sub",
      label: t("Novo subcaderno"),
      onSelect: () => newNotebook(nb.id),
    },
    { id: "renomear", label: t("Renomear"), onSelect: () => setRenaming(nb.id) },
    {
      id: "icone",
      label: t("Ícone"),
      submenu: [
        ...ICONS.map((emoji) => ({
          id: `icone-${emoji}`,
          label: emoji,
          checked: nb.icon === emoji,
          onSelect: () => useNotes.getState().setNotebookIcon(nb.id, emoji),
        })),
        { kind: "sep" as const },
        {
          id: "icone-nenhum",
          label: t("Sem ícone"),
          checked: nb.icon === null,
          onSelect: () => useNotes.getState().setNotebookIcon(nb.id, null),
        },
      ],
    },
    { kind: "sep" },
    {
      id: "excluir",
      label: t("Excluir — as notas sobem um nível"),
      danger: true,
      // Asks with the number up front: the notebook hierarchy is accumulated
      // work, and it has no trash (only notes do).
      onSelect: () => {
        const st = useNotes.getState();
        const noteCount = st.notes.filter(
          (n) => n.notebookId === nb.id && n.deletedAt === null,
        ).length;
        const children = st.notebooks.filter((n) => n.parentId === nb.id).length;
        const parts = [
          noteCount > 0 ? t("{n} nota(s)", { n: noteCount }) : null,
          children > 0 ? t("{n} subcaderno(s)", { n: children }) : null,
        ].filter(Boolean);
        const what = parts.length
          ? t("{parts} sobem um nível — nada é apagado.", { parts: parts.join(` ${t("e")} `) })
          : t("Ele está vazio.");
        void ask(
          `${t("Excluir o caderno “{name}”?", { name: nb.name })} ${what}`,
          { title: t("Excluir caderno"), kind: "warning" },
        ).then((yes) => {
          if (yes) useNotes.getState().deleteNotebook(nb.id);
        });
      },
    },
  ];

  const tree: ReactNode[] = [];
  const draw = (parentId: string | null, depth: number) => {
    for (const nb of childrenOf(notebooks, parentId)) {
      const children = childrenOf(notebooks, nb.id);
      const isClosed = closed.has(nb.id);
      tree.push(
        row({
          key: nb.id,
          label: nb.name,
          icon: nb.icon ? (
            <span className="notes-emoji">{nb.icon}</span>
          ) : (
            <BookOpen size={13} />
          ),
          count: counts.byBook.get(nb.id) ?? 0,
          active: sameCollection(collection, { kind: "book", id: nb.id }),
          depth,
          chevron: children.length > 0 ? (isClosed ? "closed" : "open") : null,
          onChevron: () =>
            setCollapsed((s) => {
              const next = new Set(s);
              if (next.has(nb.id)) next.delete(nb.id);
              else next.add(nb.id);
              return next;
            }),
          onClick: () => select({ kind: "book", id: nb.id }),
          onContextMenu: (e) => openMenu(e, notebookMenu(nb)),
          renaming:
            renaming === nb.id
              ? {
                  value: nb.name,
                  onCommit: (v) => useNotes.getState().renameNotebook(nb.id, v),
                }
              : null,
        }),
      );
      if (!isClosed) draw(nb.id, depth + 1);
    }
  };
  draw(null, 0);

  // --- render ---------------------------------------------------------------

  return (
    <nav
      className="notes-rail-body"
      aria-label={t("Coleções de anotações")}
      // The background, the section titles and the "nothing here yet"
      // sentences: everything that is not a row lands here. The rows stop
      // propagation, so this one only answers for what is left.
      onContextMenu={(e) => openMenu(e, notesRailBackgroundMenu(ctxMenu, actions))}
    >
      <div className="notes-rail-scroll">
        {row({
          key: "all",
          label: t("Todas as notas"),
          icon: <Library size={13} />,
          count: counts.all,
          active: collection.kind === "all",
          onClick: () => select({ kind: "all" }),
          onContextMenu: (e) =>
            openMenu(e, notesRailRowMenu({ kind: "all" }, ctxMenu, actions)),
        })}
        {STATUS_ROWS.map((status) =>
          row({
            key: `status-${status}`,
            label: t(STATUS_PLURAL[status]),
            icon: (
              <span
                className="notes-dot"
                style={{ background: STATUS_META[status].dot ?? "var(--text-dim)" }}
              />
            ),
            count: counts.byStatus[status],
            active: sameCollection(collection, { kind: "status", status }),
            onClick: () => select({ kind: "status", status }),
            onContextMenu: (e) =>
              openMenu(e, notesRailRowMenu({ kind: "status", status }, ctxMenu, actions)),
          }),
        )}

        <div className="notes-rail-head">
          <span>{t("Cadernos")}</span>
          <button
            className="icon-btn icon-btn--xs"
            data-tip={t("Novo caderno")}
            aria-label={t("Novo caderno")}
            onClick={() => newNotebook(null)}
          >
            <Plus size={12} />
          </button>
        </div>
        {tree.length > 0 ? (
          tree
        ) : (
          <p className="notes-rail-empty">
            {t("Cadernos agrupam notas por assunto — e aninham à vontade.")}
          </p>
        )}

        {tags.length > 0 && (
          <>
            <div className="notes-rail-head">
              <span>{t("Etiquetas")}</span>
            </div>
            {tags.map((tag) =>
              row({
                key: tag.id,
                label: tag.name,
                icon: <span className="notes-dot" style={{ background: tag.color }} />,
                count: counts.byTag.get(tag.id) ?? 0,
                active: sameCollection(collection, { kind: "tag", id: tag.id }),
                onClick: () => select({ kind: "tag", id: tag.id }),
                onContextMenu: (e) =>
                  openMenu(e, [
                    {
                      id: "renomear",
                      label: t("Renomear"),
                      onSelect: () => setRenaming(tag.id),
                    },
                    {
                      kind: "swatches",
                      label: t("Cor da etiqueta"),
                      colors: TAG_COLORS,
                      active: tag.color,
                      onPick: (color) => useNotes.getState().setTagColor(tag.id, color),
                    },
                    { kind: "sep" },
                    {
                      id: "excluir",
                      label: t("Excluir etiqueta"),
                      danger: true,
                      // Vanishes from every note that used it, with no trash
                      // and no undo: the only protection possible is to ask,
                      // and to say how many notes it is leaving.
                      onSelect: () => {
                        const uses = useNotes
                          .getState()
                          .notes.filter((n) => n.tags.includes(tag.id)).length;
                        void ask(
                          uses > 0
                            ? t("Excluir a etiqueta “{name}”? Ela sai de {n} nota(s) e não tem como desfazer — as notas ficam.", { name: tag.name, n: uses })
                            : t("Excluir a etiqueta “{name}”? Ela não está em nenhuma nota.", { name: tag.name }),
                          { title: t("Excluir etiqueta"), kind: "warning" },
                        ).then((yes) => {
                          if (yes) useNotes.getState().deleteTag(tag.id);
                        });
                      },
                    },
                  ]),
                renaming:
                  renaming === tag.id
                    ? {
                        value: tag.name,
                        onCommit: (v) => useNotes.getState().renameTag(tag.id, v),
                      }
                    : null,
              }),
            )}
          </>
        )}

        {tags.length === 0 && notebooks.length > 0 && (
          <>
            <div className="notes-rail-head">
              <span>{t("Etiquetas")}</span>
            </div>
            <p className="notes-rail-empty">
              <TagIcon size={11} aria-hidden="true" />{" "}
              {t("Etiquetas nascem na própria nota — o campo fica abaixo do título.")}
            </p>
          </>
        )}
      </div>

      <div className="notes-rail-foot">
        {row({
          key: "trash",
          label: t("Lixeira"),
          icon: <Trash2 size={13} />,
          count: counts.trash,
          active: collection.kind === "trash",
          onClick: () => select({ kind: "trash" }),
          onContextMenu: (e) =>
            openMenu(e, [
              {
                id: "esvaziar",
                label: t("Esvaziar lixeira"),
                danger: true,
                disabled: counts.trash === 0,
                onSelect: () => {
                  void ask(
                    t("Excluir de vez {n} nota(s) da lixeira? Isso não tem volta.", { n: counts.trash }),
                    { title: t("Esvaziar a lixeira?"), kind: "warning" },
                  ).then((yes) => {
                    if (yes) useNotes.getState().emptyTrash();
                  });
                },
              },
            ]),
        })}
      </div>

      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          items={menu.entries}
          onClose={() => setMenu(null)}
        />
      )}
    </nav>
  );
}
