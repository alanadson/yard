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
import { beforeEach, describe, expect, it } from "vitest";

import {
  EXTENSIONS,
  extensionControl,
  extensionInput,
  settingsExtensions,
} from "./extensions";

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
   * A radio is for picking one from a list — the color themes, nine palettes
   * chosen by looking. The two icon themes also take turns, but they are a
   * pair sitting side by side: two switches that retire each other read as
   * one rule, while two radios in a column of switches read as a broken
   * design. The store retires the sibling; the panel's job is to keep the
   * pair in sight (the test below).
   */
  it("only a color theme asks for a radio; the icon themes are switches like the rest", () => {
    const byId = new Map(EXTENSIONS.map((e) => [e.id, e]));
    expect(extensionControl(byId.get("symbols")!)).toBe("switch");
    expect(extensionControl(byId.get("material-icons")!)).toBe("switch");
    expect(extensionControl(byId.get("minimap")!)).toBe("switch");
    const theme = EXTENSIONS.find((e) => e.kind === "themes")!;
    expect(extensionControl(theme)).toBe("radio");
  });

  it("mutually exclusive siblings sit next to each other in the list — the switch that goes off has to be in sight", () => {
    const items = settingsExtensions();
    for (const ext of items) {
      if (!ext.category) continue;
      const sameCategory = items.filter((e) => e.category === ext.category);
      const positions = sameCategory.map((e) => items.indexOf(e));
      expect(Math.max(...positions) - Math.min(...positions)).toBe(sameCategory.length - 1);
    }
  });
});

/**
 * The input that switches an extension is the same in the Settings row and in
 * the store's card, so what a click asks of the store is decided in one pure
 * function. The regression that motivated it: the switch asked for "on" on
 * every click — it could be turned on, and never off again.
 */
describe("the input that switches an extension", () => {
  const byId = new Map(EXTENSIONS.map((e) => [e.id, e]));
  const theme = EXTENSIONS.find((e) => e.kind === "themes")!;
  const calls: [string, boolean][] = [];
  const setEnabled = (id: string, on: boolean) => {
    calls.push([id, on]);
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it("a switch that is on asks to be turned off — the regression: it asked for on again", () => {
    extensionInput(byId.get("minimap")!, true, setEnabled).onChange();
    expect(calls).toEqual([["minimap", false]]);
  });

  it("a switch that is off asks to be turned on", () => {
    extensionInput(byId.get("minimap")!, false, setEnabled).onChange();
    expect(calls).toEqual([["minimap", true]]);
  });

  it("a switch's click says nothing by itself — only the change event speaks, so a click never counts twice", () => {
    extensionInput(byId.get("minimap")!, true, setEnabled).onClick();
    expect(calls).toEqual([]);
  });

  it("an icon theme is a switch too; turning it on is the store's cue to retire the sibling", () => {
    const input = extensionInput(byId.get("material-icons")!, false, setEnabled);
    expect(input.type).toBe("checkbox");
    expect(input.role).toBe("switch");
    input.onChange();
    expect(calls).toEqual([["material-icons", true]]);
  });

  it("a color theme is a radio in its category's group, and the change event turns it on", () => {
    const input = extensionInput(theme, false, setEnabled);
    expect(input.type).toBe("radio");
    expect(input.name).toBe("color-theme");
    input.onClick();
    expect(calls).toEqual([]);
    input.onChange();
    expect(calls).toEqual([[theme.id, true]]);
  });

  it("the radio already on turns off by the click — a checked radio fires no change, and no theme is a valid choice", () => {
    extensionInput(theme, true, setEnabled).onClick();
    expect(calls).toEqual([[theme.id, false]]);
  });
});
