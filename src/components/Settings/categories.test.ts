/**
 * Settings stopped being a dialog with five stacked sections and became a
 * screen with a sidebar. That creates a piece of state that did not exist
 * before — *which category is open* — and that state arrives from outside:
 * from a button's `openModal("preferences", "extensoes")`, from a search item.
 *
 * A value from outside is a value to validate. An unknown category must not
 * leave the screen with nothing in the middle: it falls back to the first
 * one, which is the one that opens on its own.
 */
import { describe, expect, it } from "vitest";

import { SETTINGS_CATEGORIES, isValidCategory } from "./categories";

describe("which category the screen opens", () => {
  it("what is not a category becomes the first one, instead of an empty screen", () => {
    expect(isValidCategory("extensoes")).toBe("extensoes");
    expect(isValidCategory("teclado")).toBe("interface");
    expect(isValidCategory(undefined)).toBe("interface");
    expect(isValidCategory(null)).toBe("interface");
    expect(isValidCategory(7)).toBe("interface");
    expect(isValidCategory({ id: "dados" })).toBe("interface");
  });

  it("every category in the menu is accepted by its own id", () => {
    for (const c of SETTINGS_CATEGORIES) expect(isValidCategory(c.id)).toBe(c.id);
  });

  it("the first one in the menu is what the screen opens when nothing was asked for", () => {
    expect(isValidCategory("")).toBe(SETTINGS_CATEGORIES[0].id);
  });

  /**
   * The main column's header is `title` + `description`. A category missing
   * either opens the screen with a blank where the title goes — the kind of
   * hole that only shows when someone clicks that row.
   */
  it("every category has a label, a title and a description", () => {
    for (const c of SETTINGS_CATEGORIES) {
      expect(c.label.length, c.id).toBeGreaterThan(0);
      expect(c.title.length, c.id).toBeGreaterThan(0);
      expect(c.desc.length, c.id).toBeGreaterThan(0);
    }
  });

  it("no id repeats in the menu", () => {
    const ids = SETTINGS_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
