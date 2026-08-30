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
    const on = fileMenu(tabEntries, { wrap: true, media: false, dirty: false, git: false, eolCrlf: false, encoding: "utf-8" }, { toggleWrap, openExternal: vi.fn(), compareHead: vi.fn(), compareSaved: vi.fn(), setEol: vi.fn(), reopenWith: vi.fn() });
    const off = fileMenu(tabEntries, { wrap: false, media: false, dirty: false, git: false, eolCrlf: false, encoding: "utf-8" }, { toggleWrap, openExternal: vi.fn(), compareHead: vi.fn(), compareSaved: vi.fn(), setEol: vi.fn(), reopenWith: vi.fn() });
    expect(findItem(on, "quebra")?.checked).toBe(true);
    expect(findItem(off, "quebra")?.checked).toBe(false);
    findItem(on, "quebra")?.onSelect?.();
    expect(toggleWrap).toHaveBeenCalledTimes(1);
  });

  it("a viewed image offers the default app instead of wrapping", () => {
    // Nobody wraps a PNG; what a picture wants is the app that draws it.
    const openExternal = vi.fn();
    const entries = fileMenu(tabEntries, { wrap: false, media: true, dirty: false, git: false, eolCrlf: false, encoding: "utf-8" }, { toggleWrap: vi.fn(), openExternal, compareHead: vi.fn(), compareSaved: vi.fn(), setEol: vi.fn(), reopenWith: vi.fn() });
    expect(findItem(entries, "quebra")).toBeUndefined();
    findItem(entries, "externo")?.onSelect?.();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("the tab's own entries follow, after a separator, untouched", () => {
    const entries = fileMenu(tabEntries, { wrap: false, media: false, dirty: false, git: false, eolCrlf: false, encoding: "utf-8" }, { toggleWrap: vi.fn(), openExternal: vi.fn(), compareHead: vi.fn(), compareSaved: vi.fn(), setEol: vi.fn(), reopenWith: vi.fn() });
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

/**
 * Comparing the file with itself, from the file's own menu.
 *
 * Both comparisons existed already, but only from the Source control tab: to
 * see what you had changed in the file in front of you, you had to go and
 * find it in a list somewhere else. The two questions belong to the document,
 * so they hang off the document's title.
 */
describe("fileMenu, the two comparisons", () => {
  const act = () => ({
    toggleWrap: vi.fn(),
    openExternal: vi.fn(),
    compareHead: vi.fn(),
    compareSaved: vi.fn(),
    setEol: vi.fn(),
    reopenWith: vi.fn(),
  });

  const view = (over: Partial<{ media: boolean; dirty: boolean; git: boolean }> = {}) => ({
    wrap: false,
    media: over.media ?? false,
    dirty: over.dirty ?? false,
    git: over.git ?? true,
    eolCrlf: false,
    encoding: "utf-8",
  });

  it("offers the comparison with HEAD for a file in a repository", () => {
    const a = act();
    const entries = fileMenu([], view(), a);

    findItem(entries, "diff-head")?.onSelect?.();

    expect(a.compareHead).toHaveBeenCalledTimes(1);
  });

  it("leaves HEAD out when the project is not a git repository", () => {
    // There is no HEAD to compare against, and a menu row that errors when
    // pressed is worse than one that is not there.
    expect(findItem(fileMenu([], view({ git: false }), act()), "diff-head")).toBeUndefined();
  });

  it("offers the comparison with the disk only while there is a draft", () => {
    // With no draft the two sides are the same text, and the tab would open
    // saying nothing.
    expect(findItem(fileMenu([], view({ dirty: true }), act()), "diff-saved")).toBeDefined();
    expect(findItem(fileMenu([], view({ dirty: false }), act()), "diff-saved")).toBeUndefined();
  });

  it("runs the comparison with the disk when picked", () => {
    const a = act();

    findItem(fileMenu([], view({ dirty: true }), a), "diff-saved")?.onSelect?.();

    expect(a.compareSaved).toHaveBeenCalledTimes(1);
  });

  it("offers neither for a picture", () => {
    // A PNG has no lines to compare, and the viewer would draw an empty diff.
    const entries = fileMenu([], view({ media: true, dirty: true }), act());

    expect(findItem(entries, "diff-head")).toBeUndefined();
    expect(findItem(entries, "diff-saved")).toBeUndefined();
  });
});

/**
 * Choosing the line ending.
 *
 * The buffer is always LF, so this is metadata: the row says what the next
 * save will write. It reads as a pair of choices rather than a switch because
 * "CRLF" and "LF" are the words the reader already knows, and a switch would
 * have to be labelled with one of them anyway.
 */
describe("fileMenu, the line ending", () => {
  const act = () => ({
    toggleWrap: vi.fn(),
    openExternal: vi.fn(),
    compareHead: vi.fn(),
    compareSaved: vi.fn(),
    setEol: vi.fn(),
    reopenWith: vi.fn(),
  });

  const view = (over: Partial<{ media: boolean; eolCrlf: boolean }> = {}) => ({
    wrap: false,
    media: over.media ?? false,
    dirty: false,
    git: false,
    eolCrlf: over.eolCrlf ?? false,
    encoding: "utf-8",
  });

  it("ticks the ending the file is on", () => {
    const lf = fileMenu([], view({ eolCrlf: false }), act());
    expect(findItem(lf, "eol-lf")?.checked).toBe(true);
    expect(findItem(lf, "eol-crlf")?.checked).toBe(false);

    const crlf = fileMenu([], view({ eolCrlf: true }), act());
    expect(findItem(crlf, "eol-crlf")?.checked).toBe(true);
  });

  it("asks for the ending that was picked", () => {
    const a = act();
    const entries = fileMenu([], view({ eolCrlf: false }), a);

    findItem(entries, "eol-crlf")?.onSelect?.();

    expect(a.setEol).toHaveBeenCalledWith(true);
  });

  it("says nothing about line endings for a picture", () => {
    const entries = fileMenu([], view({ media: true }), act());

    expect(findItem(entries, "eol-lf")).toBeUndefined();
    expect(findItem(entries, "eol-crlf")).toBeUndefined();
  });
});

/**
 * Opening a file in another encoding.
 *
 * A submenu rather than four more rows: it is the least used control on this
 * menu and the one with the most options, and the reader who needs it knows
 * the word they are looking for.
 *
 * Nothing here guesses. UTF-16 announces itself with a BOM and is picked up
 * on its own; Windows-1252 decodes any byte sequence at all, so it can only
 * ever be chosen by hand, and this is the hand.
 */
describe("fileMenu, reopening in another encoding", () => {
  const act = () => ({
    toggleWrap: vi.fn(),
    openExternal: vi.fn(),
    compareHead: vi.fn(),
    compareSaved: vi.fn(),
    setEol: vi.fn(),
    reopenWith: vi.fn(),
  });

  const view = (over: Partial<{ media: boolean; encoding: string }> = {}) => ({
    wrap: false,
    media: over.media ?? false,
    dirty: false,
    git: false,
    eolCrlf: false,
    encoding: over.encoding ?? "utf-8",
  });

  it("offers the four the backend can read", () => {
    const row = findItem(fileMenu([], view(), act()), "codificacao");

    expect(row?.submenu?.length).toBe(4);
  });

  it("ticks the one the file was read with", () => {
    const rows = findItem(fileMenu([], view({ encoding: "utf-16le" }), act()), "codificacao")
      ?.submenu as MenuEntry[];

    const ticked = rows.filter((r) => "checked" in r && r.checked);

    expect(ticked).toHaveLength(1);
    expect(ticked[0]).toMatchObject({ id: "enc-utf-16le" });
  });

  it("reopens in the one that was picked", () => {
    const a = act();
    const rows = findItem(fileMenu([], view(), a), "codificacao")?.submenu as MenuEntry[];

    const pick = rows.find((r) => "id" in r && r.id === "enc-windows-1252");
    (pick as { onSelect?: () => void }).onSelect?.();

    expect(a.reopenWith).toHaveBeenCalledWith("windows-1252");
  });

  it("says nothing about encodings for a picture", () => {
    expect(findItem(fileMenu([], view({ media: true }), act()), "codificacao")).toBeUndefined();
  });
});
