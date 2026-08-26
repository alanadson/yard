/**
 * The rules of the document header — the row between the tabs and the text.
 *
 * The header used to be a wall of nine icons over a raw path. What is left on
 * it is decided here, not in the JSX: the save button exists only while there
 * is something to save, and everything that is *about the file* (reload,
 * reveal, wrap, open elsewhere) lives in one menu that opens from the path
 * itself. A rule in JSX is a rule nobody sees fail until the button is gone.
 */
import { describe, expect, it, vi } from "vitest";

import { fileMenu, mdBar, showSave } from "./chrome";
import type { MenuEntry } from "../ContextMenu";

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

describe("showSave", () => {
  it("shows the button only while there is a draft to write", () => {
    expect(showSave({ readOnly: false, dirty: true, saving: false })).toBe(true);
    expect(showSave({ readOnly: false, dirty: false, saving: false })).toBe(false);
  });

  it("keeps the button up while the write is still in flight", () => {
    // The draft is gone the moment the store accepts the write, but the
    // button says "salvando…" until the disk answers — dropping it mid-word
    // would read as the save having vanished.
    expect(showSave({ readOnly: false, dirty: false, saving: true })).toBe(true);
  });

  it("never offers to save a file that opened read-only", () => {
    expect(showSave({ readOnly: true, dirty: true, saving: false })).toBe(false);
  });
});

describe("fileMenu", () => {
  const tabEntries: MenuEntry[] = [
    { id: "fechar", label: "Fechar" },
    { kind: "sep" },
    { id: "revelar", label: "Mostrar na pasta" },
  ];

  it("offers line wrapping as a checked state and toggles it", () => {
    const toggleWrap = vi.fn();
    const on = fileMenu(tabEntries, { wrap: true, media: false }, { toggleWrap, openExternal: vi.fn() });
    const off = fileMenu(tabEntries, { wrap: false, media: false }, { toggleWrap, openExternal: vi.fn() });
    expect(findItem(on, "quebra")?.checked).toBe(true);
    expect(findItem(off, "quebra")?.checked).toBe(false);
    findItem(on, "quebra")?.onSelect?.();
    expect(toggleWrap).toHaveBeenCalledTimes(1);
  });

  it("a viewed image offers the default app instead of wrapping", () => {
    // Nobody wraps a PNG; what a picture wants is the app that draws it.
    const openExternal = vi.fn();
    const entries = fileMenu(tabEntries, { wrap: false, media: true }, { toggleWrap: vi.fn(), openExternal });
    expect(findItem(entries, "quebra")).toBeUndefined();
    findItem(entries, "externo")?.onSelect?.();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("the tab's own entries follow, after a separator, untouched", () => {
    const entries = fileMenu(tabEntries, { wrap: false, media: false }, { toggleWrap: vi.fn(), openExternal: vi.fn() });
    const cut = entries.findIndex((e) => "id" in e && e.id === "fechar");
    expect(entries[cut - 1]).toEqual({ kind: "sep" });
    expect(entries.slice(cut)).toEqual(tabEntries);
  });
});

describe("mdBar", () => {
  // The regression this locks down: the "how to look at the markdown" group
  // moved out of the path row and into the formatting capsule, as its own
  // slot at the end. The capsule used to be hidden in reading mode — with
  // the modes inside it, hiding it there would leave the reader with no way
  // back to the text at all.
  it("a reading page still gets the bar — it is the only way back to the text", () => {
    expect(mdBar(true, "read").bar).toBe(true);
    expect(mdBar(true, "read").modes).toBe(true);
  });

  it("drops the formatting on the reading page: there is no editor under it", () => {
    expect(mdBar(true, "read").formatting).toBe(false);
    for (const mode of ["live", "source", "split"] as const) {
      expect(mdBar(true, mode).formatting).toBe(true);
    }
  });

  it("a file that is not markdown has no bar at all", () => {
    expect(mdBar(false, "live").bar).toBe(false);
  });
});
