/**
 * The pane's context menu — the tab bar outside the tabs, the empty pane and
 * the "no terminal in this group" area.
 *
 * The tabs already had a menu; the pane around them had none, and that is
 * where the click of someone who wants to *open* something lands (the tab
 * they want does not even exist yet). The rules these assertions lock down:
 *
 * - the notebook only docks in one place at a time, so "Anotações aqui" is
 *   disabled in the pane where it already is;
 * - the layout mode in use comes checked — the menu is also a readout;
 * - switching to canvas is a decision for the whole group, not the pane: the
 *   entry exists, but separate from the ones that open things in this pane.
 */
import { describe, expect, it, vi } from "vitest";

import { paneMenu, type PaneMenuActions } from "./paneMenu";
import type { MenuEntry } from "../components/ContextMenu";

function actions(): PaneMenuActions {
  return {
    newCli: vi.fn(),
    newBrowser: vi.fn(),
    dockNotes: vi.fn(),
    setMode: vi.fn(),
  };
}

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const ids = (entries: MenuEntry[]) =>
  entries.filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e).map((e) => e.id);

describe("paneMenu", () => {
  it("open a CLI here is the first entry, with the shortcut in view", () => {
    const act = actions();
    const menu = paneMenu({ mode: "auto", notesHere: false }, act);
    expect(ids(menu)[0]).toBe("cli");
    expect(findItem(menu, "cli")?.shortcut).toBe("Ctrl+T");
    findItem(menu, "cli")?.onSelect?.();
    expect(act.newCli).toHaveBeenCalled();
  });

  it("with the notebook already in this pane, 'Anotações aqui' is disabled", () => {
    expect(findItem(paneMenu({ mode: "auto", notesHere: true }, actions()), "notas")?.disabled).toBe(
      true,
    );
    expect(
      findItem(paneMenu({ mode: "auto", notesHere: false }, actions()), "notas")?.disabled,
    ).toBeFalsy();
  });

  it("the layout mode in use comes checked", () => {
    const sub = findItem(paneMenu({ mode: "spotlight", notesHere: false }, actions()), "modo")?.submenu ?? [];
    expect(findItem(sub, "modo-spotlight")?.checked).toBe(true);
    expect(findItem(sub, "modo-auto")?.checked).toBe(false);
  });

  it("choosing a mode asks for exactly that mode", () => {
    const act = actions();
    const sub = findItem(paneMenu({ mode: "auto", notesHere: false }, act), "modo")?.submenu ?? [];
    findItem(sub, "modo-canvas")?.onSelect?.();
    expect(act.setMode).toHaveBeenCalledWith("canvas");
  });

  it("all four modes are there — the menu hides none", () => {
    const sub = findItem(paneMenu({ mode: "auto", notesHere: false }, actions()), "modo")?.submenu ?? [];
    expect(ids(sub)).toEqual(["modo-auto", "modo-grid", "modo-spotlight", "modo-canvas"]);
  });
});
