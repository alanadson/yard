/**
 * The context menu of the file tree.
 *
 * The rows already had a menu. The tree's **background** — the space below
 * the last file, which is half the panel in a small project — returned an
 * empty list: the menu opened with nothing inside, which is worse than not
 * opening.
 *
 * The rules these assertions lock down:
 *
 * - clicking a folder creates inside it; clicking a file creates **next to**
 *   it, in the folder that contains it (creating inside a file does not exist);
 * - clicking the background creates at the project root;
 * - the background neither renames nor deletes anything: there is no target,
 *   and a "Delete…" entry with no target is a scare waiting to happen.
 */
import { describe, expect, it, vi } from "vitest";

import { fileTreeMenu, type FileTreeMenuActions } from "./fileTreeMenu";
import type { MenuEntry } from "../components/ContextMenu";

function actions(): FileTreeMenuActions {
  return {
    draft: vi.fn(),
    rename: vi.fn(),
    copyPath: vi.fn(),
    reveal: vi.fn(),
    remove: vi.fn(),
    refresh: vi.fn(),
  };
}

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const ids = (entries: MenuEntry[]) =>
  entries.filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e).map((e) => e.id);

const theFile = { name: "flow.ts", path: "src/lib/flow.ts", dir: false };
const folder = { name: "lib", path: "src/lib", dir: true };

describe("fileTreeMenu", () => {
  it("on the tree's background the menu is not empty — it creates at the root", () => {
    const act = actions();
    const menu = fileTreeMenu(null, "C:/proj", act);
    expect(menu.length).toBeGreaterThan(0);
    findItem(menu, "new-file")?.onSelect?.();
    expect(act.draft).toHaveBeenCalledWith("", false);
  });

  it("the background neither renames nor deletes — there is no target at all", () => {
    const menu = fileTreeMenu(null, "C:/proj", actions());
    expect(ids(menu)).not.toContain("rename");
    expect(ids(menu)).not.toContain("delete");
  });

  it("the background offers to re-read the folder from disk", () => {
    const act = actions();
    findItem(fileTreeMenu(null, "C:/proj", act), "refresh")?.onSelect?.();
    expect(act.refresh).toHaveBeenCalled();
  });

  it("clicking a folder creates inside it", () => {
    const act = actions();
    findItem(fileTreeMenu(folder, "C:/proj", act), "new-dir")?.onSelect?.();
    expect(act.draft).toHaveBeenCalledWith("src/lib", true);
  });

  it("clicking a file creates next to it, in the folder that contains it", () => {
    const act = actions();
    findItem(fileTreeMenu(theFile, "C:/proj", act), "new-file")?.onSelect?.();
    expect(act.draft).toHaveBeenCalledWith("src/lib", false);
  });

  it("delete is destructive and warns that a folder takes its contents along", () => {
    expect(findItem(fileTreeMenu(theFile, "C:/proj", actions()), "delete")?.danger).toBe(true);
    const act = actions();
    findItem(fileTreeMenu(folder, "C:/proj", act), "delete")?.onSelect?.();
    expect(act.remove).toHaveBeenCalledWith(folder);
  });

  it("show in Explorer sends the OS path, not the relative one", () => {
    const act = actions();
    findItem(fileTreeMenu(theFile, "C:/proj", act), "reveal")?.onSelect?.();
    expect(act.reveal).toHaveBeenCalledWith("C:\\proj\\src\\lib\\flow.ts");
    // On the background, the target is the root itself.
    const act2 = actions();
    findItem(fileTreeMenu(null, "C:/proj", act2), "reveal")?.onSelect?.();
    expect(act2.reveal).toHaveBeenCalledWith("C:/proj");
  });
});
