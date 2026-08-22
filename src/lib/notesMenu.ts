/**
 * The notebook's context menus that do not belong to a specific row.
 *
 * The notebook already knew how to open a menu on the notebook, the tag, the
 * note and the trash. The rest of the column — "Todas as notas", the status
 * rows, the section titles, the empty space — and the whole list stayed mute
 * on the right button. Here lives *what* each of those places offers; who
 * executes is the store, injected as `NotesMenuActions` so the rule is
 * testable without a screen.
 *
 * The decision that matters most is in `nova-nota`: the note is born from the
 * **clicked** collection, so the menu selects before creating. Right-clicking
 * "Em espera" while in "Todas" and getting a note without a status would be
 * the wrong thing, and a silent one.
 */
import { NOTE_SORTS, STATUS_META, type Collection, type NoteSort } from "./notes";
import type { MenuEntry } from "../components/ContextMenu";

export interface NotesMenuActions {
  select: (collection: Collection) => void;
  createNote: () => void;
  newNotebook: (parentId: string | null) => void;
  setSort: (sort: NoteSort) => void;
  setShowResolved: (value: boolean) => void;
  clearQuery: () => void;
  focusSearch: () => void;
  /** Collapses (`true`) or opens (`false`) every notebook with children. */
  setFolded: (folded: boolean) => void;
  emptyTrash: () => void;
}

export interface NotesMenuContext {
  sort: NoteSort;
  showResolved: boolean;
  query: string;
  trashCount: number;
  /** How many notebooks have children — with none, there is nothing to collapse. */
  foldableCount: number;
  allFolded: boolean;
}

const SORT_LABEL: Record<NoteSort, string> = {
  updated: "Última edição",
  created: "Criação",
  title: "Título",
};

/**
 * Being born resolved does not exist: `createNote` demotes `done`/`dropped`
 * to "no status", so promising "new note here" on those rows would be a lie.
 */
function acceptsNewNote(c: Collection): boolean {
  if (c.kind === "trash") return false;
  if (c.kind === "status") return c.status === "active" || c.status === "paused";
  return true;
}

/**
 * The status as an adjective — "ativa", "em espera".
 *
 * The rail speaks in the plural ("Ativas", "Em espera") because it lists
 * collections; the menu speaks of **one** note. Gluing the plural into the
 * sentence gave "Nova nota em Em espera", the kind of mistake that only shows
 * up when someone actually reads the menu.
 */
function asAdjective(c: Collection): string | null {
  if (c.kind !== "status") return null;
  return STATUS_META[c.status].label.toLocaleLowerCase("pt-BR");
}

function sortEntry(ctx: NotesMenuContext, act: NotesMenuActions): MenuEntry {
  return {
    id: "ordenar",
    label: "Ordenar por",
    submenu: NOTE_SORTS.map((s) => ({
      id: `ordenar-${s}`,
      label: SORT_LABEL[s],
      checked: ctx.sort === s,
      onSelect: () => act.setSort(s),
    })),
  };
}

function resolvedEntry(ctx: NotesMenuContext, act: NotesMenuActions): MenuEntry {
  return {
    id: "resolvidas",
    label: ctx.showResolved
      ? "Esconder concluídas e descartadas"
      : "Mostrar concluídas e descartadas",
    checked: ctx.showResolved,
    onSelect: () => act.setShowResolved(!ctx.showResolved),
  };
}

function foldEntry(ctx: NotesMenuContext, act: NotesMenuActions): MenuEntry | null {
  if (ctx.foldableCount === 0) return null;
  return {
    id: "dobrar",
    label: ctx.allFolded ? "Expandir todos os cadernos" : "Recolher todos os cadernos",
    onSelect: () => act.setFolded(!ctx.allFolded),
  };
}

function emptyTrashEntry(ctx: NotesMenuContext, act: NotesMenuActions): MenuEntry {
  return {
    id: "esvaziar",
    label: "Esvaziar lixeira",
    danger: true,
    // Disabled, not absent: it is the same entry in the same place when the
    // trash fills up — the hand does not have to relearn where it is.
    disabled: ctx.trashCount === 0,
    onSelect: act.emptyTrash,
  };
}

/**
 * The menu of the rows that had none: "Todas as notas" and the four
 * statuses. `alvo` is **that row's** collection, which may not be the open one.
 */
export function notesRailRowMenu(
  target: Collection,
  ctx: NotesMenuContext,
  act: NotesMenuActions,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (acceptsNewNote(target)) {
    const adjective = asAdjective(target);
    entries.push({
      id: "nova-nota",
      label: adjective ? `Nova nota ${adjective}` : "Nova nota aqui",
      onSelect: () => {
        // The order is the behaviour: `createNote` reads the open collection.
        act.select(target);
        act.createNote();
      },
    });
  }
  entries.push({
    id: "novo-caderno",
    label: "Novo caderno",
    onSelect: () => act.newNotebook(null),
  });
  entries.push({ kind: "sep" }, sortEntry(ctx, act));
  // In a status collection the list is already of a single status: the
  // toggle changes nothing, and an entry that does nothing is worse than none.
  if (target.kind !== "status" && target.kind !== "trash") {
    entries.push(resolvedEntry(ctx, act));
  }
  const foldItem = foldEntry(ctx, act);
  if (foldItem) entries.push({ kind: "sep" }, foldItem);
  return entries;
}

/** The column's empty space and the section titles — the "organise the notebook" menu. */
export function notesRailBackgroundMenu(
  ctx: NotesMenuContext,
  act: NotesMenuActions,
): MenuEntry[] {
  const entries: MenuEntry[] = [
    { id: "nova-nota", label: "Nova nota", onSelect: act.createNote },
    { id: "novo-caderno", label: "Novo caderno", onSelect: () => act.newNotebook(null) },
  ];
  const foldItem = foldEntry(ctx, act);
  if (foldItem) entries.push({ kind: "sep" }, foldItem);
  entries.push({ kind: "sep" }, emptyTrashEntry(ctx, act));
  return entries;
}

/** The middle list: search bar, header and the blank space below. */
export function notesListMenu(
  collection: Collection,
  ctx: NotesMenuContext,
  act: NotesMenuActions,
): MenuEntry[] {
  const inTrash = collection.kind === "trash";
  const entries: MenuEntry[] = [];
  if (!inTrash) {
    entries.push({ id: "nova-nota", label: "Nova nota", onSelect: act.createNote });
    entries.push({ kind: "sep" });
  }
  entries.push(sortEntry(ctx, act));
  if (!inTrash && collection.kind !== "status") {
    entries.push(resolvedEntry(ctx, act));
  }
  entries.push(
    { kind: "sep" },
    { id: "buscar", label: "Buscar nas anotações", shortcut: "Ctrl+Shift+F", onSelect: act.focusSearch },
    {
      id: "limpar",
      label: "Limpar a busca",
      disabled: ctx.query.trim() === "",
      onSelect: act.clearQuery,
    },
  );
  if (inTrash) entries.push({ kind: "sep" }, emptyTrashEntry(ctx, act));
  return entries;
}
