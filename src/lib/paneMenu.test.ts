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
 * - the canvas is **not** here at all. It is the boards, a place of their
 *   own reached from the sidebar, and a project's pane has no canvas to
 *   offer: an entry for it would flip nothing and mislead everyone.
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

const onGrid = { mode: "auto", notesHere: false } as const;

describe("paneMenu", () => {
  it("open a CLI here is the first entry, with the shortcut in view", () => {
    const act = actions();
    const menu = paneMenu(onGrid, act);
    expect(ids(menu)[0]).toBe("cli");
    expect(findItem(menu, "cli")?.shortcut).toBe("Ctrl+T");
    findItem(menu, "cli")?.onSelect?.();
    expect(act.newCli).toHaveBeenCalled();
  });

  it("with the notebook already in this pane, 'Anotações aqui' is disabled", () => {
    expect(findItem(paneMenu({ ...onGrid, notesHere: true }, actions()), "notas")?.disabled).toBe(
      true,
    );
    expect(findItem(paneMenu(onGrid, actions()), "notas")?.disabled).toBeFalsy();
  });

  it("the layout mode in use comes checked", () => {
    const sub =
      findItem(paneMenu({ ...onGrid, mode: "spotlight" }, actions()), "modo")?.submenu ?? [];
    expect(findItem(sub, "modo-spotlight")?.checked).toBe(true);
    expect(findItem(sub, "modo-auto")?.checked).toBe(false);
  });

  it("choosing a mode asks for exactly that mode", () => {
    const act = actions();
    const sub = findItem(paneMenu(onGrid, act), "modo")?.submenu ?? [];
    findItem(sub, "modo-grid")?.onSelect?.();
    expect(act.setMode).toHaveBeenCalledWith("grid");
  });

  it("the submenu holds the three grid shapes — the canvas is not one of them", () => {
    const sub = findItem(paneMenu(onGrid, actions()), "modo")?.submenu ?? [];
    expect(ids(sub)).toEqual(["modo-auto", "modo-grid", "modo-spotlight"]);
  });

  /**
   * The contract that changed: the menu used to carry a "Canvas" entry that
   * turned the group to its other surface. A project's group has no other
   * surface now (the canvas is the boards), so the entry is gone, not
   * disabled: a pane cannot become a board.
   */
  it("offers no way onto the canvas: a project's pane has no board behind it", () => {
    expect(ids(paneMenu(onGrid, actions()))).toEqual(["cli", "browser", "notas", "modo"]);
  });
});
