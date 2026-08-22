/**
 * The keyboard map now shows up in two places: whole in the full list
 * (`Ctrl+Shift+H`) and summarised in the Shortcuts category of Settings. Two
 * hand-written lists drift apart within a week — the screen would show a
 * shortcut whose key has already changed.
 *
 * So there is a single table, and the screen asks for the groups **by
 * title**. It is a loose link on purpose (the screen does not know the
 * table's internal order), and the price of that is this test: renaming a
 * group up there emptied the category on screen, silently.
 */
import { describe, expect, it } from "vitest";

import {
  SETTINGS_SHORTCUTS,
  SHORTCUT_GROUPS,
  groupsNamed,
} from "./shortcuts";

describe("the groups the Settings screen asks for", () => {
  it("all exist in the table and come in the requested order", () => {
    const groups = groupsNamed(SETTINGS_SHORTCUTS);
    expect(groups.map((g) => g.title)).toEqual([...SETTINGS_SHORTCUTS]);
  });

  it("none of them reaches the screen empty", () => {
    for (const g of groupsNamed(SETTINGS_SHORTCUTS)) {
      expect(g.items.length, `group ${g.title} is empty`).toBeGreaterThan(0);
    }
  });

  it("a title that does not exist is dropped, not turned into an empty group", () => {
    expect(groupsNamed(["Janela", "Grupo Que Não Existe"]).map((g) => g.title)).toEqual(
      ["Janela"],
    );
  });

  it("the whole table is still the source of the full list", () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(SETTINGS_SHORTCUTS.length);
    for (const g of SHORTCUT_GROUPS) expect(g.items.length).toBeGreaterThan(0);
  });
});
