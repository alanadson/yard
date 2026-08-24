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
 * - the canvas is **not** a fourth layout mode. It is the group's other
 *   surface, with its own entry, and choosing it must not disturb the
 *   Grade/Holofote the user pinned for the panes.
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
    showSurface: vi.fn(),
  };
}

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const ids = (entries: MenuEntry[]) =>
  entries.filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e).map((e) => e.id);

const onGrid = { mode: "auto", surface: "grid", notesHere: false } as const;

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
   * The regression this locks down: `mode` used to hold `"canvas"` as a
   * fourth value, so going to the board threw away the Holofote the user had
   * pinned — and coming back landed them on the automatic grid.
   */
  it("the canvas has its own entry, and asking for it says nothing about the mode", () => {
    const act = actions();
    const menu = paneMenu({ ...onGrid, mode: "spotlight" }, act);
    const quadro = findItem(menu, "quadro");
    expect(quadro?.checked).toBe(false);
    quadro?.onSelect?.();
    expect(act.showSurface).toHaveBeenCalledWith("canvas");
    expect(act.setMode).not.toHaveBeenCalled();
  });

  it("with the board up, its entry comes checked and takes the group back to the panes", () => {
    const act = actions();
    const quadro = findItem(paneMenu({ ...onGrid, surface: "canvas" }, act), "quadro");
    expect(quadro?.checked).toBe(true);
    quadro?.onSelect?.();
    expect(act.showSurface).toHaveBeenCalledWith("grid");
  });
});
