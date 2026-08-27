/**
 * What is left of the catalog once the store shelf is gone.
 *
 * The shelf was the reason the catalog carried prose — a name, an author, a
 * licence, a paragraph and a live preview per card. None of that is drawn
 * anywhere now: each feature is a row written in the Settings section of the
 * surface it changes (`Settings/features.test.ts` is what keeps one from being
 * forgotten). So the list is down to the two things nobody can write twice —
 * **which ids exist**, because that is what the kv is allowed to hold, and
 * **which of them take turns**, because that is what the store enforces on the
 * way in and on every switch.
 *
 * The trap this file exists for is the second one, and it is silent: the ids
 * here are the filter `parseEnabled` runs an old profile through, and an id
 * that leaves the list is a switch that is quietly forgotten the next time the
 * app opens.
 */
import { describe, expect, it } from "vitest";

import { SCHEME_IDS } from "./colorSchemes";
import { EXTENSIONS } from "./extensions";
import { ICON_THEMES } from "./iconTheme";

describe("the catalog of what ships turned off", () => {
  it("no id repeats — the kv is a map, and the second entry would win in silence", () => {
    const ids = EXTENSIONS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The regression this locks out: a colour scheme is remembered in `ext.scheme`
   * today, but every profile written before the split still keeps it as a
   * boolean in `ext.enabled` — and `parseEnabled` drops any id the catalog no
   * longer knows *before* `parseSchemeChoice` gets to migrate it. Dropping the
   * schemes from here would take the theme off every screen that has one, with
   * no error and nothing to click to get it back.
   */
  it("every colour scheme the app can paint is still an id here — old profiles are read through this list", () => {
    const ids = new Set<string>(EXTENSIONS.map((e) => e.id));
    expect(SCHEME_IDS.length).toBeGreaterThan(0);
    for (const id of SCHEME_IDS) expect(ids.has(id), id).toBe(true);
  });

  it("the colour schemes take turns — two painting at once is two owners of one colour", () => {
    for (const id of SCHEME_IDS) {
      expect(EXTENSIONS.find((e) => e.id === id)?.category, id).toBe("color-theme");
    }
  });
});

/**
 * The icon themes are one slot in two places: a `category` here, which is what
 * makes turning one on retire the other, and a list in `lib/iconTheme.ts`,
 * which is what the picker shows. Two lists that must not drift — a third
 * theme added to one and not the other is either a theme nobody can choose or
 * a theme that fails to retire its sibling.
 */
describe("the icon themes", () => {
  it("the picker's list is exactly the catalog's icon-theme category, in the same order", () => {
    const category = EXTENSIONS.filter((e) => e.category === "icon-theme").map((e) => e.id);
    expect(ICON_THEMES.map((theme) => theme.id)).toEqual(category);
    expect(category.length).toBeGreaterThan(1);
  });
});
