/**
 * The context menu of the file tab.
 *
 * The tab closed through three paths (the X, middle-click, Ctrl+W) and had no
 * menu at all — "close the others", the gesture of tidying the bar after an
 * hour of work, existed nowhere in the app.
 *
 * The rules these assertions lock down are about reach: "the others" and "to
 * the right" change meaning with the tab's position in the bar, and promising
 * "save" on a file the editor opened read-only (binary, truncated, lossy
 * decoding) is promising a write that would corrupt the file.
 */
import { describe, expect, it, vi } from "vitest";

import { editorTabMenu, type EditorTabMenuActions } from "./editorTabMenu";
import type { MenuEntry } from "../components/ContextMenu";

function actions(): EditorTabMenuActions {
  return {
    close: vi.fn(),
    closeMany: vi.fn(),
    save: vi.fn(),
    reload: vi.fn(),
    copyPath: vi.fn(),
    reveal: vi.fn(),
    closeScoped: vi.fn(),
    togglePin: vi.fn(),
    revealInTree: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  };
}

const tab = (id: string) => ({ id, path: `src/${id}.ts` });

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const three = [tab("a"), tab("b"), tab("c")];

describe("editorTabMenu", () => {
  it("close takes only this tab", () => {
    const act = actions();
    findItem(
      editorTabMenu(
        { id: "b", path: "src/b.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false, pinned: false },
        three,
        act,
      ),
      "fechar",
    )?.onSelect?.();
    expect(act.close).toHaveBeenCalledWith("b");
  });

  // The contract changed on purpose: these two used to hand `closeMany` a
  // list this module computed. They cannot any more, because "the others" now
  // has an exception the menu cannot see, a pinned tab, and the list has to be
  // built where the pins are known (`lib/tabRules.ts`, through the store).
  it("'close the others' asks the store for every tab but this one", () => {
    const act = actions();
    findItem(
      editorTabMenu(
        { id: "b", path: "src/b.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false, pinned: false },
        three,
        act,
      ),
      "outras",
    )?.onSelect?.();
    expect(act.closeScoped).toHaveBeenCalledWith("b", "others");
  });

  it("'close to the right' asks the store for what comes after this tab", () => {
    const act = actions();
    findItem(
      editorTabMenu(
        { id: "a", path: "src/a.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false, pinned: false },
        three,
        act,
      ),
      "direita",
    )?.onSelect?.();
    expect(act.closeScoped).toHaveBeenCalledWith("a", "right");
  });

  it("with a single tab, 'the others' and 'to the right' are dimmed", () => {
    const menu = editorTabMenu(
      { id: "a", path: "src/a.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false, pinned: false },
      [tab("a")],
      actions(),
    );
    expect(findItem(menu, "outras")?.disabled).toBe(true);
    expect(findItem(menu, "direita")?.disabled).toBe(true);
  });

  it("on the last tab of the bar, 'to the right' is dimmed but 'the others' is not", () => {
    const menu = editorTabMenu(
      { id: "c", path: "src/c.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false, pinned: false },
      three,
      actions(),
    );
    expect(findItem(menu, "direita")?.disabled).toBe(true);
    expect(findItem(menu, "outras")?.disabled).toBeFalsy();
  });

  it("save only wakes up with a draft to write", () => {
    const stripped = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: false, readOnly: false, missing: false, pinned: false },
      three,
      actions(),
    );
    const dirty = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: true, readOnly: false, missing: false, pinned: false },
      three,
      actions(),
    );
    expect(findItem(stripped, "salvar")?.disabled).toBe(true);
    expect(findItem(dirty, "salvar")?.disabled).toBeFalsy();
  });

  it("a read-only file does not promise to save even with a draft", () => {
    const menu = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: true, readOnly: true, missing: false, pinned: false },
      three,
      actions(),
    );
    expect(findItem(menu, "salvar")?.disabled).toBe(true);
  });

  it("a file gone from disk neither reloads nor shows in the folder", () => {
    const menu = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: false, readOnly: false, missing: true, pinned: false },
      three,
      actions(),
    );
    expect(findItem(menu, "recarregar")?.disabled).toBe(true);
    expect(findItem(menu, "revelar")?.disabled).toBe(true);
  });

  it("copy path sends the relative one; the full one glues the root in front", () => {
    const act = actions();
    const menu = editorTabMenu(
      { id: "a", path: "src/a.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false, pinned: false },
      three,
      act,
    );
    findItem(menu, "copiar")?.onSelect?.();
    expect(act.copyPath).toHaveBeenCalledWith("src/a.ts");
    findItem(menu, "copiar-abs")?.onSelect?.();
    expect(act.copyPath).toHaveBeenLastCalledWith("C:\\proj\\src\\a.ts");
  });
});

/**
 * A comparison tab (the diff opened beside the CLIs) has no file of its own:
 * nothing to save and nothing to reload from disk — but the path it compares
 * is a real file, so copying it and showing it in the folder still work.
 */
describe("editorTabMenu — a comparison tab", () => {
  it("has nothing to reload from disk, and still copies and reveals the file it compares", () => {
    const act = actions();
    const m = editorTabMenu(
      {
        id: "d",
        path: "src/a.ts",
        root: "C:/proj",
        dirty: false,
        readOnly: true,
        missing: false,
        pinned: false,
        comparison: true,
      },
      [tab("a"), { id: "d", path: "src/a.ts" }],
      act,
    );
    expect(findItem(m, "recarregar")?.disabled).toBe(true);
    expect(findItem(m, "salvar")?.disabled).toBe(true);
    expect(findItem(m, "revelar")?.disabled).toBe(false);
    findItem(m, "copiar")?.onSelect?.();
    expect(act.copyPath).toHaveBeenCalledWith("src/a.ts");
  });
});

/**
 * What the tab menu grew, and why each row is where it is.
 *
 * Pinning and "close the saved ones" both exist to protect work from a tidy:
 * the first says "not this one, ever", the second says "everything with
 * nothing in it". Rename, delete and reveal are the tree's own commands,
 * reachable from the tab because the tab is where the file is when you decide
 * you want them.
 */
describe("editorTabMenu, the rows that protect work", () => {
  const bar = [tab("a"), tab("b"), tab("c")];
  const target = (over: Partial<Parameters<typeof editorTabMenu>[0]> = {}) => ({
    id: "b",
    path: "src/b.ts",
    root: "C:/r",
    dirty: false,
    readOnly: false,
    missing: false,
    pinned: false,
    ...over,
  });

  it("pins the tab, and says so when it is already pinned", () => {
    const act = actions();

    const off = editorTabMenu(target(), bar, act);
    expect(findItem(off, "fixar")?.label).toBe("Fixar");

    const on = editorTabMenu(target({ pinned: true }), bar, act);
    expect(findItem(on, "fixar")?.label).toBe("Desafixar");

    findItem(on, "fixar")?.onSelect?.();
    expect(act.togglePin).toHaveBeenCalledWith("b");
  });

  it("offers to close every tab with nothing unsaved in it", () => {
    const act = actions();

    findItem(editorTabMenu(target(), bar, act), "salvas")?.onSelect?.();

    expect(act.closeScoped).toHaveBeenCalledWith("b", "saved");
  });

  it("hands the two crowd commands to the store, which knows about pins", () => {
    // The menu used to compute the list itself, which is how "fechar as
    // outras" would happily close a pinned tab.
    const act = actions();
    const entries = editorTabMenu(target(), bar, act);

    findItem(entries, "outras")?.onSelect?.();
    findItem(entries, "direita")?.onSelect?.();

    expect(act.closeScoped).toHaveBeenCalledWith("b", "others");
    expect(act.closeScoped).toHaveBeenCalledWith("b", "right");
  });

  it("reveals the file in the tree it came from", () => {
    const act = actions();

    findItem(editorTabMenu(target(), bar, act), "arvore")?.onSelect?.();

    expect(act.revealInTree).toHaveBeenCalledWith("src/b.ts");
  });

  it("renames and deletes the file from the tab", () => {
    const act = actions();
    const entries = editorTabMenu(target(), bar, act);

    findItem(entries, "renomear")?.onSelect?.();
    findItem(entries, "excluir")?.onSelect?.();

    expect(act.rename).toHaveBeenCalledWith("src/b.ts");
    expect(act.remove).toHaveBeenCalledWith("src/b.ts");
  });

  it("offers none of the file commands on a comparison", () => {
    // A comparison has no file of its own to rename, delete or reveal.
    const entries = editorTabMenu(target({ comparison: true }), bar, actions());

    expect(findItem(entries, "renomear")).toBeUndefined();
    expect(findItem(entries, "excluir")).toBeUndefined();
    expect(findItem(entries, "arvore")).toBeUndefined();
  });

  it("does not offer to rename or delete a file that is already gone", () => {
    const entries = editorTabMenu(target({ missing: true }), bar, actions());

    expect(findItem(entries, "renomear")?.disabled).toBe(true);
    expect(findItem(entries, "excluir")?.disabled).toBe(true);
  });
});
