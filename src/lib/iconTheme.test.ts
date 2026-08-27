/**
 * The file icon themes stopped being two switches on a store shelf and became
 * one picker in Ajustes → Editor de código, next to the colour theme. A picker
 * is a different promise from a switch: it says "one of these, or none", and
 * the two themes really are one slot — both drawn over the same tree, the same
 * tabs, the same Busca.
 *
 * The rule lives here, apart from the JSX, because the half that breaks
 * quietly is *clearing*: turning a theme off has no control of its own any
 * more, it is the "Nenhum" entry, and a picker that only knows how to turn
 * things on leaves the tree wearing a theme the screen says is off.
 */
import { describe, expect, it } from "vitest";

import { ICON_THEMES, iconThemeOptions, iconThemePick, iconThemeValue } from "./iconTheme";

const NONE = "Nenhum";

describe("which icon theme the picker shows", () => {
  it("nothing on reads as the empty value — the Yard's own glyphs", () => {
    expect(iconThemeValue({})).toBe("");
    expect(iconThemeValue({ minimap: true })).toBe("");
  });

  it("the theme that is on is the picker's value", () => {
    expect(iconThemeValue({ symbols: true })).toBe("symbols");
    expect(iconThemeValue({ "material-icons": true })).toBe("material-icons");
  });

  it("two on at once — a hand-edited kv — reads as the first in the catalog, never as none", () => {
    expect(iconThemeValue({ symbols: true, "material-icons": true })).toBe("symbols");
  });
});

describe("the picker's list", () => {
  it("opens with the way out, then every theme the app ships", () => {
    const options = iconThemeOptions(NONE);
    expect(options[0]).toEqual({ value: "", label: NONE });
    expect(options.slice(1).map((o) => o.value)).toEqual(ICON_THEMES.map((x) => x.id));
    expect(ICON_THEMES.length).toBeGreaterThan(1);
  });

  it("names every theme — an unnamed row is an empty line in the pop-up", () => {
    for (const theme of ICON_THEMES) expect(theme.name.trim(), theme.id).not.toBe("");
  });
});

describe("what a pick asks the store for", () => {
  it("choosing a theme asks to turn it on — the store retires the sibling", () => {
    expect(iconThemePick({}, "material-icons")).toEqual({ id: "material-icons", on: true });
    expect(iconThemePick({ symbols: true }, "material-icons")).toEqual({
      id: "material-icons",
      on: true,
    });
  });

  /**
   * The regression this locks out: "Nenhum" was the absence of a switch, so
   * picking it asked for nothing at all — the picker went back to Nenhum and
   * the tree carried on with Symbols' icons.
   */
  it("choosing Nenhum turns off the one that was on", () => {
    expect(iconThemePick({ symbols: true }, "")).toEqual({ id: "symbols", on: false });
  });

  it("choosing Nenhum with nothing on asks for nothing", () => {
    expect(iconThemePick({}, "")).toBeNull();
  });

  it("choosing the one already on asks for nothing — no needless write to the kv", () => {
    expect(iconThemePick({ symbols: true }, "symbols")).toBeNull();
  });

  it("a value the catalog does not know asks for nothing, and never clears by accident", () => {
    expect(iconThemePick({ symbols: true }, "seti")).toBeNull();
    expect(iconThemePick({ symbols: true }, "minimap")).toBeNull();
  });
});
