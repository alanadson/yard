/**
 * The Extensions category in Settings is a panel of switches, not the store:
 * each row is a name, a sentence and a button. Color themes do not fit that
 * format — they exclude each other (turning one on turns its sibling off, and
 * the sibling may be off screen) and the choice is made by looking at the
 * palette, not by reading the name. That is why the full store
 * (`Ctrl+Shift+X`) remains their place, with radio and preview.
 *
 * The regression this test locks out: a new extension enters the catalog and
 * nobody remembers the panel — it can only be switched on from the store, and
 * the screen that promises "everything ships with Yard" lies by omission.
 */
import { describe, expect, it } from "vitest";

import { EXTENSIONS, extensionControl, settingsExtensions } from "./extensions";

describe("the extensions the Settings panel lists", () => {
  it("no color theme gets in — they are chosen by palette, in the store", () => {
    expect(settingsExtensions().some((e) => e.kind === "themes")).toBe(false);
  });

  it("the rest of the catalog is all there, in the same order", () => {
    const expected = EXTENSIONS.filter((e) => e.kind !== "themes").map((e) => e.id);
    expect(settingsExtensions().map((e) => e.id)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  /**
   * A switch promises independence, and the two icon themes break that
   * promise: turning one on turns the other off. The store already solved
   * this with a radio; the panel uses the same rule, or repeats the bug in a
   * new place.
   */
  it("whoever takes turns with a sibling gets a radio, not a switch", () => {
    const byId = new Map(EXTENSIONS.map((e) => [e.id, e]));
    expect(extensionControl(byId.get("symbols")!)).toBe("radio");
    expect(extensionControl(byId.get("material-icons")!)).toBe("radio");
    expect(extensionControl(byId.get("minimap")!)).toBe("switch");
  });

  it("mutually exclusive siblings sit next to each other in the list — a lone radio cannot be read", () => {
    const items = settingsExtensions();
    for (const ext of items) {
      if (!ext.category) continue;
      const sameCategory = items.filter((e) => e.category === ext.category);
      const positions = sameCategory.map((e) => items.indexOf(e));
      expect(Math.max(...positions) - Math.min(...positions)).toBe(sameCategory.length - 1);
    }
  });
});
