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
        { id: "b", path: "src/b.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false },
        three,
        act,
      ),
      "fechar",
    )?.onSelect?.();
    expect(act.close).toHaveBeenCalledWith("b");
  });

  it("'close the others' takes every tab but this one", () => {
    const act = actions();
    findItem(
      editorTabMenu(
        { id: "b", path: "src/b.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false },
        three,
        act,
      ),
      "outras",
    )?.onSelect?.();
    expect(act.closeMany).toHaveBeenCalledWith(["a", "c"]);
  });

  it("'close to the right' takes only what comes after, in bar order", () => {
    const act = actions();
    findItem(
      editorTabMenu(
        { id: "a", path: "src/a.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false },
        three,
        act,
      ),
      "direita",
    )?.onSelect?.();
    expect(act.closeMany).toHaveBeenCalledWith(["b", "c"]);
  });

  it("with a single tab, 'the others' and 'to the right' are dimmed", () => {
    const menu = editorTabMenu(
      { id: "a", path: "src/a.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false },
      [tab("a")],
      actions(),
    );
    expect(findItem(menu, "outras")?.disabled).toBe(true);
    expect(findItem(menu, "direita")?.disabled).toBe(true);
  });

  it("on the last tab of the bar, 'to the right' is dimmed but 'the others' is not", () => {
    const menu = editorTabMenu(
      { id: "c", path: "src/c.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false },
      three,
      actions(),
    );
    expect(findItem(menu, "direita")?.disabled).toBe(true);
    expect(findItem(menu, "outras")?.disabled).toBeFalsy();
  });

  it("save only wakes up with a draft to write", () => {
    const stripped = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: false, readOnly: false, missing: false },
      three,
      actions(),
    );
    const dirty = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: true, readOnly: false, missing: false },
      three,
      actions(),
    );
    expect(findItem(stripped, "salvar")?.disabled).toBe(true);
    expect(findItem(dirty, "salvar")?.disabled).toBeFalsy();
  });

  it("a read-only file does not promise to save even with a draft", () => {
    const menu = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: true, readOnly: true, missing: false },
      three,
      actions(),
    );
    expect(findItem(menu, "salvar")?.disabled).toBe(true);
  });

  it("a file gone from disk neither reloads nor shows in the folder", () => {
    const menu = editorTabMenu(
      { id: "a", path: "a", root: "C:/proj", dirty: false, readOnly: false, missing: true },
      three,
      actions(),
    );
    expect(findItem(menu, "recarregar")?.disabled).toBe(true);
    expect(findItem(menu, "revelar")?.disabled).toBe(true);
  });

  it("copy path sends the relative one; the full one glues the root in front", () => {
    const act = actions();
    const menu = editorTabMenu(
      { id: "a", path: "src/a.ts", root: "C:/proj", dirty: false, readOnly: false, missing: false },
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
