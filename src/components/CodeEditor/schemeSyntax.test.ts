/**
 * An attribute's value is a string, and nothing in this editor was painting it
 * as one. `@lezer/html` gives `lang="pt-BR"` the `attributeValue` tag — a tag
 * of its own, not a flavour of `string` — and neither highlight table listed
 * it, so every HTML and JSX attribute in the app rendered in the plain text
 * ink while VS Code shows it in the string colour. It is the kind of hole that
 * only shows up next to the other editor: a whole class of token quietly
 * uncoloured, in every theme at once.
 */
import { describe, expect, it } from "vitest";
import { Tag, tags as t } from "@lezer/highlight";
import type { TagStyle } from "@codemirror/language";

import { yardHighlightSpecs } from "./cm";
import { syntaxSpecs } from "./schemeSyntax";
import { schemeFor, SCHEMES, syntaxVars } from "../../lib/colorSchemes";

/** What a table paints a tag with — the first rule that names it, as CodeMirror reads it. */
function colorOf(specs: readonly TagStyle[], tag: Tag): string | undefined {
  const spec = specs.find((s) => ([] as Tag[]).concat(s.tag as Tag | Tag[]).includes(tag));
  return spec?.color;
}

describe("the highlight tables", () => {
  const tables: [string, readonly TagStyle[]][] = [
    ["the Yard's own palette", yardHighlightSpecs],
    ["a colour scheme", syntaxSpecs(schemeFor("theme-min-dark")!.syntax)],
  ];

  it.each(tables)("%s paints an attribute's value like the string it is", (_name, specs) => {
    const string = colorOf(specs, t.string);
    expect(string).toBeDefined();
    expect(colorOf(specs, t.attributeValue)).toBe(string);
  });

  /**
   * The same hole, one tag over: `@lezer/css` gives `.search-item` the
   * `className` tag and `#sidebar` the `labelName` one, and only the first was
   * named here — so a stylesheet came out with half its selectors coloured and
   * half in plain ink. `labelName` is a base tag, so unlike a modified tag it
   * falls back to nothing at all.
   */
  it.each(tables)("%s paints an id selector like the class selector beside it", (_name, specs) => {
    const className = colorOf(specs, t.className);
    expect(className).toBeDefined();
    expect(colorOf(specs, t.labelName)).toBe(className);
  });

  it.each(tables)("%s still tells the attribute's name from its value", (_name, specs) => {
    expect(colorOf(specs, t.attributeName)).not.toBe(colorOf(specs, t.attributeValue));
  });
});

/**
 * The guarantee the two specific holes above were symptoms of: a colour scheme
 * has to reach wherever the Yard's own palette reaches. The two tables are
 * written apart — one in `cm.ts` against CSS custom properties, one here
 * against a scheme's ten roles — and nothing but this test makes them agree
 * on *which tags exist*.
 *
 * The failure mode is one-directional and silent. Add a tag to the Yard's
 * table alone and the default editor gains a colour while every scheme keeps
 * rendering that token in plain ink: ten themes quietly worse than no theme,
 * on whichever files happen to contain it. Nobody reports that — it looks like
 * the theme simply being the theme.
 */
describe("the two tables cover the same ground", () => {
  /** Every tag a table names, flattened out of the one-or-many `tag` field. */
  const tagsOf = (specs: readonly TagStyle[]): Set<Tag> =>
    new Set(specs.flatMap((s) => ([] as Tag[]).concat(s.tag as Tag | Tag[])));

  /** `@lezer/highlight`'s own name for a tag, for a legible failure. */
  const nameOf = (tag: Tag): string => {
    for (const [name, value] of Object.entries(t)) {
      if (value === tag) return name;
      if (typeof value === "function") {
        // The modifiers (`function`, `definition`, `constant`…) build the same
        // Tag instance for the same base, so identity still answers.
        for (const base of Object.values(t)) {
          if (base instanceof Tag && (value as (b: Tag) => Tag)(base) === tag) {
            return `${name}(${nameOf(base)})`;
          }
        }
      }
    }
    return "an unnamed tag";
  };

  const yard = tagsOf(yardHighlightSpecs);
  const scheme = tagsOf(syntaxSpecs(schemeFor("theme-min-dark")!.syntax));

  it("a scheme paints every tag the Yard's own palette paints", () => {
    const missing = [...yard].filter((tag) => !scheme.has(tag)).map(nameOf);
    expect(missing, `unpainted under every colour scheme: ${missing.join(", ")}`).toEqual([]);
  });

  it("and claims no tag the Yard's own palette leaves alone", () => {
    const extra = [...scheme].filter((tag) => !yard.has(tag)).map(nameOf);
    expect(extra, `painted only under a scheme: ${extra.join(", ")}`).toEqual([]);
  });

  /**
   * The two names the ignore grammar emits (`ignoreSyntax.ts`), which
   * `StreamLanguage`'s default table turns into these tags. A grammar written
   * against a token name no table paints is a file that opens uncoloured no
   * matter which theme is on — the thing this whole pass is about.
   */
  it.each([
    ["a comment", t.comment],
    ["an operator", t.operator],
  ])("paints %s, which the ignore grammar leans on", (_what, tag) => {
    expect(yard.has(tag)).toBe(true);
    expect(scheme.has(tag)).toBe(true);
  });
});

/**
 * One palette, two mechanisms. The editor gets a CodeMirror `HighlightStyle`
 * (`syntaxSpecs`); the diff viewer and the markdown preview get CSS custom
 * properties (`syntaxVars`), because they paint `tok-*` classes on plain React
 * trees with no CodeMirror anywhere. Both are hand-written mappings of the
 * same ten roles, and they have to agree token for token.
 *
 * If they drift, the symptom is a file disagreeing with itself: the editor tab
 * says a keyword is pink and the diff tab of the same file, open beside it,
 * says it is purple. That is worse than a theme not applying — it reads as the
 * app being unsure what it is looking at.
 */
describe("the editor and the diff say the same thing", () => {
  /**
   * Every scheme, not one. Dracula happens to give tags and keywords the same
   * pink, so a drift between the two mappings on exactly that role passes
   * unnoticed against it — the palettes where the roles are distinct are the
   * ones doing the checking.
   */
  const vars = syntaxVars(schemeFor("theme-dracula")!.syntax);

  /** Each custom property beside the tag whose `tok-*` class it paints. */
  const PAIRS: [string, Tag][] = [
    ["--syn-comment", t.comment],
    ["--syn-keyword", t.keyword],
    ["--syn-string", t.string],
    ["--syn-number", t.number],
    ["--syn-function", t.function(t.variableName)],
    ["--syn-type", t.typeName],
    ["--syn-property", t.propertyName],
    ["--syn-tag", t.tagName],
    ["--syn-operator", t.operator],
    ["--syn-definition", t.definition(t.variableName)],
    ["--syn-variable", t.variableName],
    ["--syn-constant", t.constant(t.variableName)],
  ];

  it("covers every property the CSS side writes — no pair left unchecked", () => {
    expect(PAIRS.map(([name]) => name).sort()).toEqual(Object.keys(vars).sort());
  });

  it.each(PAIRS)("%s is the colour the highlight table gives the same token", (name, tag) => {
    for (const scheme of SCHEMES) {
      const painted = colorOf(syntaxSpecs(scheme.syntax), tag);
      expect(painted, `${name} has no tag painting it`).toBeDefined();
      expect(syntaxVars(scheme.syntax)[name], `${scheme.id} · ${name}`).toBe(painted);
    }
  });
});
