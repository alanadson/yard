/**
 * The context menu of the files panel (Live and Changes).
 *
 * The panel's rows only answered to left-click — opening the diff — and
 * right-click did nothing. What these assertions lock down are the rules that
 * only show up when the menu promises what it cannot deliver:
 *
 * - a **deleted** file neither opens in the editor nor shows in the folder:
 *   the path no longer exists on disk, and both actions would end in an error;
 * - a **binary** file does not open in the text editor;
 * - "copy full path" only exists when the project root is known.
 *
 * An impossible entry is dimmed, never absent: the row above and the row
 * below stay where the hand memorized them.
 */
import { describe, expect, it, vi } from "vitest";

import { changedFileMenu, changesPanelMenu, type ChangesMenuActions } from "./changesMenu";
import type { ChangedFile } from "./ipc";
import type { MenuEntry } from "../components/ContextMenu";

function actions(): ChangesMenuActions {
  return {
    openDiff: vi.fn(),
    openInEditor: vi.fn(),
    copyPath: vi.fn(),
    reveal: vi.fn(),
    refresh: vi.fn(),
    clearFeed: vi.fn(),
    close: vi.fn(),
  };
}

const theFile = (over: Partial<ChangedFile> = {}): ChangedFile => ({
  path: "src/lib/flow.ts",
  origPath: null,
  status: "modified",
  staged: false,
  additions: 3,
  deletions: 1,
  binary: false,
  index: "none",
  worktree: "modified",
  conflict: null,
  ...over,
});

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const ids = (entries: MenuEntry[]) =>
  entries.filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e).map((e) => e.id);

describe("changedFileMenu", () => {
  it("opening the diff is the first entry — it is what the click already did", () => {
    const act = actions();
    const menu = changedFileMenu(theFile(), { root: "C:/proj" }, act);
    expect(ids(menu)[0]).toBe("diff");
    findItem(menu, "diff")?.onSelect?.();
    expect(act.openDiff).toHaveBeenCalledWith("src/lib/flow.ts");
  });

  it("a deleted file does not promise to open in the editor or show in the folder", () => {
    const menu = changedFileMenu(theFile({ status: "deleted" }), { root: "C:/proj" }, actions());
    expect(findItem(menu, "editor")?.disabled).toBe(true);
    expect(findItem(menu, "revelar")?.disabled).toBe(true);
    // …but the diff stays: that is precisely how you see what was deleted.
    expect(findItem(menu, "diff")?.disabled).toBeFalsy();
  });

  it("a binary file does not open in the text editor", () => {
    const menu = changedFileMenu(theFile({ binary: true }), { root: "C:/proj" }, actions());
    expect(findItem(menu, "editor")?.disabled).toBe(true);
    expect(findItem(menu, "revelar")?.disabled).toBeFalsy();
  });

  it("copy path sends the relative one, which is how the repository speaks", () => {
    const act = actions();
    findItem(changedFileMenu(theFile(), { root: "C:/proj" }, act), "copiar")?.onSelect?.();
    expect(act.copyPath).toHaveBeenCalledWith("src/lib/flow.ts");
  });

  it("with no known root, the full path is dimmed", () => {
    expect(
      findItem(changedFileMenu(theFile(), { root: null }, actions()), "copiar-abs")?.disabled,
    ).toBe(true);
    expect(
      findItem(changedFileMenu(theFile(), { root: "C:/proj" }, actions()), "copiar-abs")?.disabled,
    ).toBeFalsy();
  });

  it("inside the viewer itself, 'open the diff' goes away — it is already open", () => {
    const menu = changedFileMenu(theFile(), { root: "C:/proj", inViewer: true }, actions());
    expect(ids(menu)).not.toContain("diff");
    // …and the rest stays whole: that is precisely where the path is wanted.
    expect(ids(menu)).toContain("copiar");
    expect(ids(menu)).toContain("editor");
  });

  it("a renamed file offers to copy the name it came from", () => {
    const noOrigin = changedFileMenu(theFile(), { root: "C:/proj" }, actions());
    expect(ids(noOrigin)).not.toContain("copiar-origem");
    const withOrigin = changedFileMenu(
      theFile({ status: "renamed", origPath: "src/lib/fluxo.ts" }),
      { root: "C:/proj" },
      actions(),
    );
    expect(ids(withOrigin)).toContain("copiar-origem");
  });
});

describe("changesPanelMenu", () => {
  it("on the live tab the menu clears the feed; on changes, it refreshes git", () => {
    expect(ids(changesPanelMenu({ tab: "live", hasRepo: true, feedCount: 2 }, actions()))).toContain(
      "limpar",
    );
    expect(
      ids(changesPanelMenu({ tab: "review", hasRepo: true, feedCount: 0 }, actions())),
    ).not.toContain("limpar");
  });

  it("refresh git disappears when the folder is not a repository", () => {
    expect(
      ids(changesPanelMenu({ tab: "review", hasRepo: false, feedCount: 0 }, actions())),
    ).not.toContain("atualizar");
  });

  it("clearing an empty feed is dimmed", () => {
    expect(
      findItem(changesPanelMenu({ tab: "live", hasRepo: true, feedCount: 0 }, actions()), "limpar")
        ?.disabled,
    ).toBe(true);
  });

  it("close panel is always there, with the shortcut in view", () => {
    const item = findItem(
      changesPanelMenu({ tab: "live", hasRepo: false, feedCount: 0 }, actions()),
      "fechar",
    );
    expect(item?.shortcut).toBe("Ctrl+Shift+D");
  });
});
