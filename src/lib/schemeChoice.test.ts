/**
 * A colour scheme used to be one switch painting two surfaces at once, and the
 * two surfaces are not the same job: the terminal's palette is the sixteen
 * tones a CLI draws its own output in, the editor's is what the grammar makes
 * of a file. Wanting Ayu under an agent and GitHub Dark under the code is an
 * ordinary thing to want, and there was no way to say it.
 *
 * So there are two slots now. The rules that matter are here rather than in a
 * component, because all three of them are the kind that break silently: a
 * profile that still holds the old boolean must not lose its theme on the way
 * across, an id that left the catalog must not resurrect, and "linked" has to
 * be *read* off the two slots instead of stored beside them — a third field
 * saying they are equal is a third field that can be wrong.
 */
import { describe, expect, it } from "vitest";

import { SCHEME_IDS, schemeFor, syntaxVars } from "./colorSchemes";
import {
  applySyntaxVars,
  isLinked,
  NO_SCHEME,
  parseSchemeChoice,
  relink,
  schemeOptions,
  schemePick,
  schemeRadio,
  schemeValue,
  setBoth,
  setSurface,
  type SchemeChoice,
} from "./schemeChoice";

describe("the two slots", () => {
  it("start on the Yard's own palette, both of them", () => {
    expect(NO_SCHEME).toEqual({ terminal: undefined, code: undefined });
    expect(isLinked(NO_SCHEME)).toBe(true);
  });

  it("paints both surfaces while the link is on", () => {
    const choice = setBoth("theme-nord");
    expect(choice).toEqual({ terminal: "theme-nord", code: "theme-nord" });
    expect(isLinked(choice)).toBe(true);
  });

  it("moves one surface without touching the other", () => {
    const choice = setSurface(setBoth("theme-nord"), "code", "theme-ayu");
    expect(choice.terminal).toBe("theme-nord");
    expect(choice.code).toBe("theme-ayu");
  });

  /**
   * The link is a reading of the two slots, never a field of its own. Two
   * surfaces on the same scheme *are* linked, however they got there — the
   * user who unlinks, sets both to Nord by hand and comes back finds the
   * switch on, because on screen there is nothing left to tell apart.
   */
  it("is linked whenever the two slots agree, however they got there", () => {
    expect(isLinked(setSurface(setBoth("theme-nord"), "code", "theme-nord"))).toBe(true);
    expect(isLinked(setSurface(setBoth("theme-nord"), "code", "theme-ayu"))).toBe(false);
  });

  it("counts the Yard's own palette on both sides as linked, not as nothing", () => {
    expect(isLinked({ terminal: undefined, code: undefined })).toBe(true);
    expect(isLinked({ terminal: undefined, code: "theme-ayu" })).toBe(false);
  });

  /**
   * Turning the link back on has to resolve to one of the two, and the pick is
   * stated where the user can read it (the store's hint): the terminal's wins.
   * Silent either way, so it is nailed down here.
   */
  it("re-links onto the terminal's scheme, the surface the app is built around", () => {
    const split: SchemeChoice = { terminal: "theme-nord", code: "theme-ayu" };
    expect(relink(split)).toEqual({ terminal: "theme-nord", code: "theme-nord" });
    expect(isLinked(relink(split))).toBe(true);
  });

  it("re-links onto the Yard's own palette when that is what the terminal has", () => {
    expect(relink({ terminal: undefined, code: "theme-ayu" })).toEqual(NO_SCHEME);
  });

  it("never mutates the choice it was handed", () => {
    const before = setBoth("theme-nord");
    setSurface(before, "code", "theme-ayu");
    relink(before);
    expect(before).toEqual({ terminal: "theme-nord", code: "theme-nord" });
  });
});

describe("reading the choice back off the disk", () => {
  it("reads the two slots the app wrote", () => {
    const raw = JSON.stringify({ terminal: "theme-nord", code: "theme-ayu" });
    expect(parseSchemeChoice(raw, {})).toEqual({ terminal: "theme-nord", code: "theme-ayu" });
  });

  /**
   * kv gives back text and nothing promises it is the text this app wrote —
   * a hand-edited file, a half-written value, a truncated line. None of that
   * may throw on the way to a first paint.
   */
  it.each([
    ["nothing saved yet", undefined],
    ["a truncated line", '{"terminal":'],
    ["a list where an object belongs", "[]"],
    ["the JSON null", "null"],
    ["a number in the slot", '{"terminal": 7}'],
  ])("survives %s", (_why, raw) => {
    expect(parseSchemeChoice(raw as string | undefined, {})).toEqual(NO_SCHEME);
  });

  /**
   * The same rule `parseEnabled` has for the switches: an id that left the
   * catalog is dropped on read, so an old profile cannot resurrect a scheme
   * the app no longer knows how to paint.
   */
  it("drops a scheme that has left the catalog", () => {
    const raw = JSON.stringify({ terminal: "theme-from-2021", code: "theme-ayu" });
    expect(parseSchemeChoice(raw, {})).toEqual({ terminal: undefined, code: "theme-ayu" });
  });

  it("accepts every id the catalog does ship", () => {
    for (const id of SCHEME_IDS) {
      expect(parseSchemeChoice(JSON.stringify({ terminal: id, code: id }), {}), id).toEqual({
        terminal: id,
        code: id,
      });
    }
  });
});

/**
 * Every profile that exists today holds the old shape: one boolean in
 * `ext.enabled`, painting both surfaces. Reading the new key and finding
 * nothing is exactly what those profiles look like, so "nothing saved" must
 * not mean "no theme" — it means "look in the old place". Getting this wrong
 * silently un-themes every existing install on the first launch after the
 * update, which is the kind of thing nobody reports as a bug: they just
 * assume they turned it off.
 */
describe("a profile that still holds the old single switch", () => {
  it("carries the theme across to both slots", () => {
    expect(parseSchemeChoice(undefined, { "theme-ayu": true })).toEqual({
      terminal: "theme-ayu",
      code: "theme-ayu",
    });
  });

  it("ignores a scheme the user had already turned back off", () => {
    expect(parseSchemeChoice(undefined, { "theme-ayu": false, minimap: true })).toEqual(
      NO_SCHEME,
    );
  });

  it("does not migrate over a choice the user has since made", () => {
    const raw = JSON.stringify({ terminal: "theme-nord", code: "theme-nord" });
    expect(parseSchemeChoice(raw, { "theme-ayu": true })).toEqual({
      terminal: "theme-nord",
      code: "theme-nord",
    });
  });

  /**
   * Splitting the surfaces and then putting the terminal back on the Yard's
   * own palette writes a legitimate `{}`-shaped choice. That is a choice, not
   * an empty key, so the old boolean must not come back and overwrite it.
   */
  it("does not migrate over a choice that is deliberately the Yard's own", () => {
    const raw = JSON.stringify({ terminal: null, code: "theme-ayu" });
    expect(parseSchemeChoice(raw, { "theme-nord": true })).toEqual({
      terminal: undefined,
      code: "theme-ayu",
    });
  });
});

/**
 * What one radio on a store card is and what a click on it asks for. The rule
 * lives here rather than in the card because of the half of it that has no
 * visible symptom: a radio already on fires no change event, so "click the one
 * that is on to go back to the Yard's palette" only works if the card asks for
 * it explicitly — the same hole that once left a switch in this store that
 * could never be turned off.
 */
describe("a radio on a scheme card", () => {
  const nord = setBoth("theme-nord");

  it("is on when the linked pair sits on this card's scheme", () => {
    expect(schemeRadio(nord, "theme-nord", "both").checked).toBe(true);
    expect(schemeRadio(nord, "theme-ayu", "both").checked).toBe(false);
  });

  /**
   * The linked radio speaks for both surfaces, so it must not claim to be on
   * while they disagree — one of the two would be lying about its colour.
   */
  it("is off on both cards while the surfaces disagree", () => {
    const split: SchemeChoice = { terminal: "theme-nord", code: "theme-ayu" };
    expect(schemeRadio(split, "theme-nord", "both").checked).toBe(false);
    expect(schemeRadio(split, "theme-ayu", "both").checked).toBe(false);
  });

  it("moves both surfaces when the link is on", () => {
    expect(schemeRadio(nord, "theme-ayu", "both").next).toEqual(setBoth("theme-ayu"));
  });

  it("gives the Yard's own palette back when you click the one already on", () => {
    expect(schemeRadio(nord, "theme-nord", "both").next).toEqual(NO_SCHEME);
  });

  it("moves one surface, and only that one, once split", () => {
    const split: SchemeChoice = { terminal: "theme-nord", code: "theme-ayu" };
    expect(schemeRadio(split, "theme-min-dark", "code").next).toEqual({
      terminal: "theme-nord",
      code: "theme-min-dark",
    });
    expect(schemeRadio(split, "theme-ayu", "code").checked).toBe(true);
    expect(schemeRadio(split, "theme-ayu", "terminal").checked).toBe(false);
  });

  it("clears just its own surface when you click the one already on", () => {
    const split: SchemeChoice = { terminal: "theme-nord", code: "theme-ayu" };
    expect(schemeRadio(split, "theme-ayu", "code").next).toEqual({
      terminal: "theme-nord",
      code: undefined,
    });
  });

  /**
   * One `name` per surface and a different one for the linked control: the
   * browser is what enforces one-of-N inside a group, and two groups sharing a
   * name would have the terminal's pick silently switch the editor's off.
   */
  it("puts each surface in a radio group of its own", () => {
    const names = (["both", "terminal", "code"] as const).map(
      (s) => schemeRadio(nord, "theme-ayu", s).name,
    );
    expect(new Set(names).size, names.join(" ")).toBe(3);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });
});

/**
 * The same two slots, reached from the other side: Ajustes → Terminal and
 * Ajustes → Editor each carry a picker for their own surface. That is where
 * someone who already knows what they want goes, and it is what makes the
 * split discoverable at all — the store is for browsing palettes, but nobody
 * opens a store to answer "what is the editor on right now?".
 *
 * A `<select>` speaks strings and a slot's empty value is `undefined`, so the
 * round trip through the picker is the part that can silently lose a choice.
 */
describe("the picker in Ajustes", () => {
  it("offers the Yard's own palette first, then every scheme on the shelf", () => {
    const options = schemeOptions("Padrão do Yard");
    expect(options[0]).toEqual({ value: "", label: "Padrão do Yard" });
    expect(options.slice(1).map((o) => o.value)).toEqual([...SCHEME_IDS]);
    expect(options.every((o) => o.label.length > 0)).toBe(true);
  });

  it("names each scheme the way its card does", () => {
    const ayu = schemeOptions("—").find((o) => o.value === "theme-ayu");
    expect(ayu?.label).toBe("Ayu Dark");
  });

  it("round-trips a slot through the picker's string, the empty one included", () => {
    expect(schemeValue(undefined)).toBe("");
    expect(schemeValue("theme-ayu")).toBe("theme-ayu");
    expect(schemePick("")).toBeUndefined();
    expect(schemePick("theme-ayu")).toBe("theme-ayu");
  });

  /**
   * A `<select>` can only ever hand back one of its own options, but the value
   * also arrives from a saved pref; an id the catalog dropped must read as the
   * Yard's own palette rather than as a scheme nobody can paint.
   */
  it("reads an unknown id as the Yard's own palette", () => {
    expect(schemePick("theme-from-2021")).toBeUndefined();
  });
});

/**
 * The diff viewer and the markdown preview run no CodeMirror: they paint
 * `tok-*` classes, which the sheets colour through `--syn-*`. So the editor's
 * scheme has to reach the document as custom properties, or a `.ts` in a diff
 * tab keeps the Yard's palette while the editor tab beside it wears Dracula.
 *
 * The half that breaks silently is the *removal*. Turn a scheme off and the
 * properties stay on `<html>` unless something takes them off — the editor
 * snaps back to the Yard's colours, the diff does not, and now the two
 * disagree in the opposite direction.
 */
describe("writing the code scheme onto the document", () => {
  const fakeRoot = () => {
    const props = new Map<string, string>();
    return {
      props,
      setAttribute: () => {},
      removeAttribute: () => {},
      style: {
        setProperty: (name: string, value: string) => void props.set(name, value),
        removeProperty: (name: string) => void props.delete(name),
      },
    };
  };

  it("writes the scheme's palette, every property of it", () => {
    const root = fakeRoot();
    applySyntaxVars(root, "theme-dracula");
    expect(Object.fromEntries(root.props)).toEqual(
      syntaxVars(schemeFor("theme-dracula")!.syntax),
    );
  });

  it("takes them all off again when the surface goes back to the Yard's palette", () => {
    const root = fakeRoot();
    applySyntaxVars(root, "theme-dracula");
    applySyntaxVars(root, undefined);
    expect([...root.props.keys()]).toEqual([]);
  });

  it("leaves nothing of the old scheme behind when swapping to another", () => {
    const root = fakeRoot();
    applySyntaxVars(root, "theme-dracula");
    applySyntaxVars(root, "theme-nord");
    expect(Object.fromEntries(root.props)).toEqual(syntaxVars(schemeFor("theme-nord")!.syntax));
  });

  it("treats an id it cannot paint as no scheme at all", () => {
    const root = fakeRoot();
    applySyntaxVars(root, "theme-dracula");
    applySyntaxVars(root, "theme-from-2021");
    expect([...root.props.keys()]).toEqual([]);
  });
});
