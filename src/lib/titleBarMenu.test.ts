/**
 * The title bar's context menu.
 *
 * The bar is the app's largest dead surface: outside the buttons, it is the
 * window-drag area and nothing more. Right-clicking there did nothing — not
 * even the system's window menu, which the custom decoration took out of the
 * picture.
 *
 * What these assertions lock in is the menu also being an *indicator*: each
 * panel shows checked according to whether it is open, and "Maximize" swaps
 * words when the window is already maximized. A menu that always says
 * "Maximize" on a maximized window lies about what the click will do.
 */
import { describe, expect, it, vi } from "vitest";

import { titleBarMenu, type TitleBarMenuActions } from "./titleBarMenu";
import type { MenuEntry } from "../components/ContextMenu";

function actions(): TitleBarMenuActions {
  return {
    toggleSidebar: vi.fn(),
    toggleChanges: vi.fn(),
    toggleBench: vi.fn(),
    toggleNotes: vi.fn(),
    toggleStatusBar: vi.fn(),
    openModal: vi.fn(),
    toggleMaximize: vi.fn(),
    minimize: vi.fn(),
  };
}

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const isOpen = {
  sidebar: true,
  changes: false,
  bench: false,
  notes: false,
  statusBar: true,
  maximized: false,
};

describe("titleBarMenu", () => {
  it("each panel shows checked according to whether it is open", () => {
    const menu = titleBarMenu({ ...isOpen, bench: true }, actions());
    expect(findItem(menu, "sidebar")?.checked).toBe(true);
    expect(findItem(menu, "bench")?.checked).toBe(true);
    expect(findItem(menu, "changes")?.checked).toBe(false);
  });

  /**
   * The status bar is the newest surface with no button of its own: once
   * hidden from Settings, this menu (and the bar's own) is the way to see it
   * is off and bring it back without opening Preferences.
   */
  it("the status bar is on the map too — checked while it shows, and the entry toggles it", () => {
    const act = actions();
    expect(findItem(titleBarMenu(isOpen, act), "statusbar")?.checked).toBe(true);
    const hidden = titleBarMenu({ ...isOpen, statusBar: false }, act);
    expect(findItem(hidden, "statusbar")?.checked).toBe(false);
    findItem(hidden, "statusbar")?.onSelect?.();
    expect(act.toggleStatusBar).toHaveBeenCalledTimes(1);
  });

  it("the shortcuts are on show — the menu teaches the keyboard too", () => {
    const menu = titleBarMenu(isOpen, actions());
    expect(findItem(menu, "sidebar")?.shortcut).toBe("Ctrl+B");
    expect(findItem(menu, "changes")?.shortcut).toBe("Ctrl+Shift+D");
    expect(findItem(menu, "bench")?.shortcut).toBe("Ctrl+Shift+B");
    expect(findItem(menu, "notes")?.shortcut).toBe("Ctrl+Shift+N");
  });

  it("maximize swaps words when the window is already maximized", () => {
    expect(findItem(titleBarMenu(isOpen, actions()), "maximize")?.label).toBe("Maximizar");
    expect(
      findItem(titleBarMenu({ ...isOpen, maximized: true }, actions()), "maximize")?.label,
    ).toBe("Restaurar");
  });

  it("preferences open the right modal", () => {
    const act = actions();
    findItem(titleBarMenu(isOpen, act), "prefs")?.onSelect?.();
    expect(act.openModal).toHaveBeenCalledWith("preferences");
  });

  /**
   * The store shelf had an item of its own here, next to the shortcuts, and
   * it went out with the shelf: everything it switched is a row in
   * Configurações now. What the menu still owes is the pair of windows that
   * have no other door of their own.
   */
  /**
   * The changes panel and the bench read the active project. On a board
   * there is no project on screen, so the two entries leave the map with
   * the doors they mirror: offering them would open a panel about a
   * project nobody is looking at.
   */
  it("on a board the two project panels are off the map", () => {
    const onBoard = titleBarMenu({ ...isOpen, board: true }, actions());
    const ids = onBoard
      .filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e)
      .map((e) => e.id);
    expect(ids).not.toContain("changes");
    expect(ids).not.toContain("bench");
    expect(ids).toContain("sidebar");
    expect(ids).toContain("notes");
  });

  it("the shortcuts are here too — it is the application's menu", () => {
    const act = actions();
    const menu = titleBarMenu(isOpen, act);
    expect(findItem(menu, "extensions")).toBeUndefined();
    findItem(menu, "shortcuts")?.onSelect?.();
    expect(act.openModal).toHaveBeenLastCalledWith("shortcuts");
  });
});
