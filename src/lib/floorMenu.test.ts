/**
 * The context menu of a row in the floor list.
 *
 * The row already carried three or four cramped icon buttons, each explained
 * only by a tooltip; right-clicking it did nothing. The menu is where the same
 * actions get a full name — and where the two that never fit in the row go:
 * copy the branch and copy the worktree path.
 *
 * The rules these assertions lock down all come from the same place: **the
 * ground is not a floor**. It does not land (onto what?), does not close (it
 * would take the project with it) and has no worktree of its own to reveal.
 * And a floor without git (`plain`) has neither a branch nor a landing.
 */
import { describe, expect, it, vi } from "vitest";

import { floorRowMenu, type FloorMenuActions } from "./floorMenu";
import type { MenuEntry } from "../components/ContextMenu";

function actions(): FloorMenuActions {
  return {
    goTo: vi.fn(),
    land: vi.fn(),
    runHooks: vi.fn(),
    unload: vi.fn(),
    copy: vi.fn(),
    close: vi.fn(),
  };
}

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const ids = (entries: MenuEntry[]) =>
  entries.filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e).map((e) => e.id);

const isolated = {
  isGround: false,
  floor: { kind: "isolated" as const, branch: "feat/x", worktreePath: "C:/proj/.yard/floors/x" },
  liveCount: 2,
  busy: false,
};

describe("floorRowMenu", () => {
  it("go to the floor is the first entry — it is what a click already does", () => {
    const act = actions();
    const menu = floorRowMenu(isolated, act);
    expect(ids(menu)[0]).toBe("ir");
    findItem(menu, "ir")?.onSelect?.();
    expect(act.goTo).toHaveBeenCalled();
  });

  it("the ground neither lands nor closes — it is not a floor", () => {
    const menu = floorRowMenu(
      { isGround: true, floor: undefined, liveCount: 1, busy: false },
      actions(),
    );
    expect(ids(menu)).not.toContain("land");
    expect(ids(menu)).not.toContain("close");
  });

  it("a floor without git does not land and has no branch to copy", () => {
    const menu = floorRowMenu(
      { isGround: false, floor: { kind: "plain" }, liveCount: 0, busy: false },
      actions(),
    );
    expect(ids(menu)).not.toContain("land");
    expect(ids(menu)).not.toContain("copy-branch");
    // …but closing stays: a floor without git is still a floor.
    expect(ids(menu)).toContain("close");
  });

  it("hooks only show up when the floor has hooks configured", () => {
    expect(ids(floorRowMenu(isolated, actions()))).not.toContain("hooks");
    const withHooks = floorRowMenu(
      { ...isolated, floor: { ...isolated.floor, hooks: { setup: [], run: ["npm run dev"], teardown: [] } } },
      actions(),
    );
    expect(ids(withHooks)).toContain("hooks");
  });

  it("unload is disabled with no live terminal", () => {
    expect(findItem(floorRowMenu(isolated, actions()), "unload")?.disabled).toBeFalsy();
    expect(
      findItem(floorRowMenu({ ...isolated, liveCount: 0 }, actions()), "unload")?.disabled,
    ).toBe(true);
  });

  it("with an operation in progress, everything that touches the floor is disabled", () => {
    const menu = floorRowMenu({ ...isolated, busy: true }, actions());
    expect(findItem(menu, "unload")?.disabled).toBe(true);
    expect(findItem(menu, "land")?.disabled).toBe(true);
    expect(findItem(menu, "close")?.disabled).toBe(true);
    // Going to it and copying the path touch nothing: they stay enabled.
    expect(findItem(menu, "ir")?.disabled).toBeFalsy();
    expect(findItem(menu, "copy-path")?.disabled).toBeFalsy();
  });

  it("close is destructive and is marked as such", () => {
    expect(findItem(floorRowMenu(isolated, actions()), "close")?.danger).toBe(true);
  });

  it("copy branch sends its name; copy path, the worktree", () => {
    const act = actions();
    const menu = floorRowMenu(isolated, act);
    findItem(menu, "copy-branch")?.onSelect?.();
    expect(act.copy).toHaveBeenCalledWith("feat/x");
    findItem(menu, "copy-path")?.onSelect?.();
    expect(act.copy).toHaveBeenLastCalledWith("C:/proj/.yard/floors/x");
  });
});
