/**
 * The three rows every tab bar's menu shares: fix the tab at the front, and
 * walk it one place to either side.
 *
 * They live in one builder because the bar paints four kinds of tab from
 * three different stores, and a command that exists on the CLI but not on the
 * browser next to it reads as a bug. What each kind supplies is only the
 * *doing* — the wording, the shortcut and, above all, when the command is
 * greyed out are decided here, once.
 */
import { describe, expect, it, vi } from "vitest";

import { tabOrderMenu } from "./tabOrderMenu";
import type { TabRef } from "./paneBar";
import type { MenuEntry } from "../components/ContextMenu";

/** A tab of the bar. The kind is part of it: one bar holds all four. */
const at = (id: string, pinned = false, kind: TabRef["kind"] = "doc"): TabRef => ({
  id,
  kind,
  pinned,
});

const actions = () => ({ togglePin: vi.fn(), moveBy: vi.fn() });

function item(menu: MenuEntry[], id: string) {
  return menu.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

describe("tabOrderMenu", () => {
  const bar = [at("a"), at("b"), at("c")];

  it("offers to fix a loose tab, and to unfix a pinned one", () => {
    expect(item(tabOrderMenu({ id: "a", pinned: false }, bar, actions()), "fixar")?.label).toBe(
      "Fixar",
    );
    expect(item(tabOrderMenu({ id: "a", pinned: true }, bar, actions()), "fixar")?.label).toBe(
      "Desafixar",
    );
  });

  it("fixing goes to the store that owns the tab", () => {
    const act = actions();
    item(tabOrderMenu({ id: "b", pinned: false }, bar, act), "fixar")?.onSelect?.();
    expect(act.togglePin).toHaveBeenCalledWith("b");
  });

  it("moving asks for one step, and the store works out where that lands", () => {
    const act = actions();
    const menu = tabOrderMenu({ id: "b", pinned: false }, bar, act);
    item(menu, "mover-esq")?.onSelect?.();
    item(menu, "mover-dir")?.onSelect?.();
    expect(act.moveBy).toHaveBeenNthCalledWith(1, "b", -1);
    expect(act.moveBy).toHaveBeenNthCalledWith(2, "b", 1);
  });

  /**
   * A menu row that does nothing when clicked is the worst kind: the user
   * cannot tell the command from the situation. The ends of the bar, and the
   * line between the pinned half and the loose one, are both walls.
   */
  it("dims the direction the tab cannot go", () => {
    const first = tabOrderMenu({ id: "a", pinned: false }, bar, actions());
    expect(item(first, "mover-esq")?.disabled).toBe(true);
    expect(item(first, "mover-dir")?.disabled).toBeFalsy();

    const last = tabOrderMenu({ id: "c", pinned: false }, bar, actions());
    expect(item(last, "mover-esq")?.disabled).toBeFalsy();
    expect(item(last, "mover-dir")?.disabled).toBe(true);
  });

  it("a pinned tab alone in the front half cannot move at all", () => {
    const pinnedBar = [at("p", true), at("a"), at("b")];
    const menu = tabOrderMenu({ id: "p", pinned: true }, pinnedBar, actions());
    expect(item(menu, "mover-esq")?.disabled).toBe(true);
    expect(item(menu, "mover-dir")?.disabled).toBe(true);
  });

  /**
   * The bar interleaves the kinds, so the neighbour a CLI trades places with
   * is whatever is actually beside it — a file, most of the time. Measuring
   * against the CLIs alone would grey out a step that has somewhere to go.
   */
  it("counts the neighbour of any kind, not the next one of its own", () => {
    const mixed = [at("compose"), at("cli", false, "terminal")];
    const menu = tabOrderMenu({ id: "cli", pinned: false }, mixed, actions());

    expect(item(menu, "mover-esq")?.disabled).toBeFalsy();
    expect(item(menu, "mover-dir")?.disabled).toBe(true);
  });

  it("carries the shortcut, so the menu teaches the keys", () => {
    const menu = tabOrderMenu({ id: "b", pinned: false }, bar, actions());
    expect(item(menu, "mover-esq")?.shortcut).toBe("Ctrl+Shift+←");
    expect(item(menu, "mover-dir")?.shortcut).toBe("Ctrl+Shift+→");
  });

  it("without a way to move, only the pin shows up", () => {
    // The overlay editor's header has no bar to walk along: it shows one
    // document at a time.
    const menu = tabOrderMenu({ id: "a", pinned: false }, null, { togglePin: vi.fn() });
    expect(menu.map((e) => ("id" in e ? e.id : "sep"))).toEqual(["fixar"]);
  });
});
