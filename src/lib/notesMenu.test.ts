/**
 * The notebook's context menus — the places where the right button did
 * nothing.
 *
 * The notebook already had a menu on the notebook, the tag, the note and the
 * trash. Everything else — "Todas as notas", the four status rows, the
 * section titles, the column's empty space and the whole list — stayed mute.
 * The rules these assertions lock down are the ones not visible on screen:
 *
 * - a new note is born **in the collection that was clicked**, not in the one
 *   that was open;
 * - a resolved status (done/dropped) does not offer "new note": the store
 *   refuses to be born resolved, and the menu would be promising what it
 *   does not deliver;
 * - the resolved toggle only appears where it changes something;
 * - a destructive entry with no target (empty an empty trash) shows disabled,
 *   it does not vanish — the place the hand memorised stays there.
 */
import { describe, expect, it, vi } from "vitest";

import {
  notesListMenu,
  notesRailBackgroundMenu,
  notesRailRowMenu,
  type NotesMenuActions,
  type NotesMenuContext,
} from "./notesMenu";
import type { MenuEntry } from "../components/ContextMenu";

function actions(): NotesMenuActions {
  return {
    select: vi.fn(),
    createNote: vi.fn(),
    newNotebook: vi.fn(),
    setSort: vi.fn(),
    setShowResolved: vi.fn(),
    clearQuery: vi.fn(),
    focusSearch: vi.fn(),
    setFolded: vi.fn(),
    emptyTrash: vi.fn(),
  };
}

const ctx = (over: Partial<NotesMenuContext> = {}): NotesMenuContext => ({
  sort: "updated",
  showResolved: false,
  query: "",
  trashCount: 0,
  foldableCount: 0,
  allFolded: false,
  ...over,
});

/** Ids of the item entries, in order (separators excluded). */
function ids(entries: MenuEntry[]): string[] {
  return entries
    .filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e)
    .map((e) => e.id);
}

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

describe("notesRailRowMenu", () => {
  it("a new note is born in the clicked collection, not the one that was open", () => {
    const act = actions();
    const menu = notesRailRowMenu({ kind: "status", status: "paused" }, ctx(), act);
    findItem(menu, "nova-nota")?.onSelect?.();
    expect(act.select).toHaveBeenCalledWith({ kind: "status", status: "paused" });
    expect(act.createNote).toHaveBeenCalled();
  });

  it("selects before creating — the order is what makes the note born right", () => {
    const order: string[] = [];
    const act = {
      ...actions(),
      select: vi.fn(() => order.push("select")),
      createNote: vi.fn(() => order.push("create")),
    };
    findItem(notesRailRowMenu({ kind: "all" }, ctx(), act), "nova-nota")?.onSelect?.();
    expect(order).toEqual(["select", "create"]);
  });

  it("a resolved status does not promise a new note — the store would refuse to be born that way", () => {
    for (const status of ["done", "dropped"] as const) {
      const menu = notesRailRowMenu({ kind: "status", status }, ctx(), actions());
      expect(ids(menu)).not.toContain("nova-nota");
    }
  });

  /**
   * The label came out "Nova nota em Em espera" in the first version — the
   * rail's plural ("Em espera", "Ativas") glued into a sentence that calls
   * for the adjective. The menu speaks of the note, a single one, so what
   * rules here is the status's singular label.
   */
  it("a working status promises, and says which — in readable Portuguese", () => {
    expect(
      findItem(notesRailRowMenu({ kind: "status", status: "paused" }, ctx(), actions()), "nova-nota")
        ?.label,
    ).toBe("Nova nota em espera");
    expect(
      findItem(notesRailRowMenu({ kind: "status", status: "active" }, ctx(), actions()), "nova-nota")
        ?.label,
    ).toBe("Nova nota ativa");
  });

  it("the resolved toggle only appears where it changes something", () => {
    expect(ids(notesRailRowMenu({ kind: "all" }, ctx(), actions()))).toContain("resolvidas");
    expect(
      ids(notesRailRowMenu({ kind: "status", status: "active" }, ctx(), actions())),
    ).not.toContain("resolvidas");
  });

  it("the sort in use comes checked", () => {
    const menu = notesRailRowMenu({ kind: "all" }, ctx({ sort: "title" }), actions());
    const sub = findItem(menu, "ordenar")?.submenu ?? [];
    expect(findItem(sub, "ordenar-title")?.checked).toBe(true);
    expect(findItem(sub, "ordenar-updated")?.checked).toBe(false);
  });

  it("collapse vanishes when no notebook has children — there is nothing to collapse", () => {
    expect(ids(notesRailRowMenu({ kind: "all" }, ctx(), actions()))).not.toContain("dobrar");
    expect(
      ids(notesRailRowMenu({ kind: "all" }, ctx({ foldableCount: 2 }), actions())),
    ).toContain("dobrar");
  });

  it("with everything collapsed, the entry becomes expand", () => {
    const menu = notesRailRowMenu(
      { kind: "all" },
      ctx({ foldableCount: 2, allFolded: true }),
      actions(),
    );
    expect(findItem(menu, "dobrar")?.label).toMatch(/^Expandir/);
    const act = actions();
    findItem(
      notesRailRowMenu({ kind: "all" }, ctx({ foldableCount: 2, allFolded: true }), act),
      "dobrar",
    )?.onSelect?.();
    expect(act.setFolded).toHaveBeenCalledWith(false);
  });
});

describe("notesRailBackgroundMenu", () => {
  it("the column's empty space creates note and notebook at the root", () => {
    const act = actions();
    const menu = notesRailBackgroundMenu(ctx(), act);
    expect(ids(menu)).toContain("nova-nota");
    findItem(menu, "novo-caderno")?.onSelect?.();
    expect(act.newNotebook).toHaveBeenCalledWith(null);
  });

  it("empty trash shows disabled when it is already empty", () => {
    expect(findItem(notesRailBackgroundMenu(ctx(), actions()), "esvaziar")?.disabled).toBe(
      true,
    );
    expect(
      findItem(notesRailBackgroundMenu(ctx({ trashCount: 3 }), actions()), "esvaziar")
        ?.disabled,
    ).toBeFalsy();
  });

  it("empty trash is destructive and is marked as such", () => {
    const item = findItem(notesRailBackgroundMenu(ctx({ trashCount: 1 }), actions()), "esvaziar");
    expect(item?.danger).toBe(true);
  });
});

describe("notesListMenu", () => {
  it("clear search only wakes up when there is a search", () => {
    expect(findItem(notesListMenu({ kind: "all" }, ctx(), actions()), "limpar")?.disabled).toBe(
      true,
    );
    const having = notesListMenu({ kind: "all" }, ctx({ query: "fluxo" }), actions());
    expect(findItem(having, "limpar")?.disabled).toBeFalsy();
  });

  it("in the trash the menu changes subject: empty, not create", () => {
    const menu = notesListMenu({ kind: "trash" }, ctx({ trashCount: 2 }), actions());
    expect(ids(menu)).toContain("esvaziar");
    expect(ids(menu)).not.toContain("nova-nota");
  });

  it("outside the trash, create note is the first entry", () => {
    expect(ids(notesListMenu({ kind: "all" }, ctx(), actions()))[0]).toBe("nova-nota");
  });

  it("the notebook search is always one click away", () => {
    const act = actions();
    findItem(notesListMenu({ kind: "all" }, ctx(), act), "buscar")?.onSelect?.();
    expect(act.focusSearch).toHaveBeenCalled();
  });
});
