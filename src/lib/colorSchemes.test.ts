/**
 * The schemes are data, and data is checked by reading it. What is *not* data
 * is `enabledScheme`: the store keeps every extension the user ever touched,
 * including the ones turned back off, so "which scheme is on" is a rule — and
 * the last time a switch was read for truthiness instead of `=== true` it
 * became a switch that could never be turned off.
 */
import { describe, expect, it } from "vitest";

import {
  enabledScheme,
  SCHEME_IDS,
  SCHEMES,
  schemeFor,
  syntaxVars,
  type TermPalette,
} from "./colorSchemes";
import { contrastRatio } from "./contrast";
import { DARK_TERM } from "./termTheme";

// The sheets that name the syntax custom properties, read as text — the same
// way `termTheme.test.ts` holds the terminal well against its own declaration.
import darkCss from "../styles.css?raw";
import lightCss from "../theme-light.css?raw";
import editorCss from "../components/CodeEditor/editor.css?raw";

describe("enabledScheme", () => {
  it("names the scheme that is on, ignoring the other extensions", () => {
    expect(enabledScheme({ minimap: true, "theme-ayu": true })).toBe("theme-ayu");
  });

  it("does not count a scheme the user turned back off", () => {
    expect(enabledScheme({ "theme-ayu": false, minimap: true })).toBeUndefined();
  });

  it("is undefined when no scheme was ever enabled", () => {
    expect(enabledScheme({})).toBeUndefined();
  });

  it("every id it can return is a scheme the store can resolve", () => {
    for (const id of SCHEME_IDS) {
      expect(enabledScheme({ [id]: true }), id).toBe(id);
      expect(schemeFor(id), id).toBeDefined();
    }
  });
});

/**
 * A block cursor draws the glyph under it in `cursorAccent`, so anything other
 * than the well itself leaves a coloured notch where the cursor sits.
 * `termTheme.test.ts` holds the two built-in palettes to that; the shelf is
 * every other palette that can paint the same well.
 */
describe("the shelf's palettes", () => {
  it("every cursor punches its own well through the glyph", () => {
    for (const s of SCHEMES) {
      expect(s.term.cursorAccent.toLowerCase(), s.id).toBe(s.term.background.toLowerCase());
    }
  });
});

/**
 * Min (miguelsolorio/min-theme, MIT) is the first palette here whose author
 * publishes no ANSI row for the dark side — `min-dark.json` sets exactly one,
 * `terminal.ansiBrightBlack`. The other fifteen are read off the theme's own
 * token colours, and the two hues Min has no token for (green and cyan) come
 * from the ANSI row the same author publishes in `min-light.json`. That is a
 * transcription with judgement in it, so the floors are what get asserted: a
 * hue that does not read over the well is the way this goes wrong, and it goes
 * wrong silently.
 */
describe("Min", () => {
  const HUES = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
  const min = schemeFor("theme-min-dark");

  it("is on the shelf, opened on the well min-dark.json declares", () => {
    expect(min, "the Min scheme is gone from the store").toBeDefined();
    // `editor.background`, and the one ANSI the theme sets for the dark side.
    expect(min!.term.background).toBe("#1f1f1f");
    expect(min!.term.brightBlack).toBe("#5c5c5c");
  });

  it("keeps body text at 7:1 over that well, like the built-in palettes", () => {
    expect(contrastRatio(min!.term.foreground, min!.term.background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(min!.term.cursor, min!.term.background)).toBeGreaterThanOrEqual(3);
  });

  it("every ANSI hue reads over the well (>= 3:1), normal and bright", () => {
    for (const hue of HUES) {
      const bright = `bright${hue[0].toUpperCase()}${hue.slice(1)}` as keyof TermPalette;
      expect(contrastRatio(min!.term[hue], min!.term.background), hue).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(min!.term[bright], min!.term.background), bright).toBeGreaterThanOrEqual(3);
    }
  });

  /**
   * `min-dark.json` paints strings twice, and the first transcription read the
   * file top to bottom and took the first one. Rule 6 is the bare `string`
   * scope at a muted #9db1c5 — what a markdown code span gets — and rule 13
   * puts `string.quoted | string.regexp | string.interpolated | string.template`
   * on the same orange as the tags. TextMate resolves the *most specific*
   * selector, and every string anyone actually writes is quoted, so on screen
   * Min's strings are orange: in VS Code an `integrity="sha384-…"` and the
   * `<script>` around it come out the same colour. With the muted grey the
   * editor lied about every string in the file.
   */
  it("paints strings the orange `string.quoted` wins, not the muted bare `string`", () => {
    expect(min!.syntax.string).toBe("#ffab70");
    // One rule in the file, so one colour here: tags and quoted strings together.
    expect(min!.syntax.string).toBe(min!.syntax.tag);
  });

  /**
   * The editor is the other half of a scheme, and there the ground is *not*
   * the scheme's: a scheme colours content, never the frame, so the syntax
   * lands on the appearance's own well. Min's darkest ink (`comment`) is the
   * one that could disappear there.
   */
  it("its syntax reads over the editor's own well, which no scheme repaints", () => {
    for (const [role, color] of Object.entries(min!.syntax)) {
      expect(contrastRatio(color, DARK_TERM.background), role).toBeGreaterThanOrEqual(3);
    }
  });
});

/**
 * A scheme reached the editor and stopped there. The diff viewer and the
 * markdown preview do not run CodeMirror — they paint `@lezer/highlight`'s
 * `tok-*` classes as plain React trees — and those classes were painted with
 * the Yard's palette written out as literal hex. So with Dracula on, a `.ts`
 * in the editor and the *same* `.ts` in a diff tab beside it disagreed about
 * every keyword in the file, and the store card had been promising "as cores
 * de sintaxe do editor e dos diffs de código" the whole time.
 *
 * `syntaxVars` is the bridge: the ten roles projected onto the eleven
 * `--syn-*` custom properties the sheets already read, so one palette paints
 * both worlds. What is worth holding is the coverage — a name that exists in
 * CSS with nothing behind it is a token class that silently keeps the default
 * colour under every theme.
 */
describe("a scheme reaching outside the editor", () => {
  const palette = schemeFor("theme-dracula")!.syntax;

  /** Every `--syn-*` custom property the app's sheets and tables refer to. */
  const referenced = new Set(
    [darkCss, lightCss, editorCss].flatMap((css) => css.match(/--syn-[a-z]+/g) ?? []),
  );

  it("refers to a fair number of them — a regex that stopped matching proves nothing", () => {
    expect(referenced.size).toBeGreaterThanOrEqual(8);
  });

  it("gives a value to every --syn-* the sheets read", () => {
    const vars = syntaxVars(palette);
    const missing = [...referenced].filter((name) => !(name in vars));
    expect(missing, `read by the CSS, never written: ${missing.join(", ")}`).toEqual([]);
  });

  it("writes nothing the sheets do not read — no var invented here on the side", () => {
    const extra = Object.keys(syntaxVars(palette)).filter((name) => !referenced.has(name));
    expect(extra, `written, read by nobody: ${extra.join(", ")}`).toEqual([]);
  });

  it("hands every property a real colour, straight from the scheme's own roles", () => {
    const roles = new Set(Object.values(palette));
    for (const [name, value] of Object.entries(syntaxVars(palette))) {
      expect(roles.has(value), `${name} = ${value}`).toBe(true);
    }
  });

  it("does it for every scheme on the shelf, not just the one above", () => {
    for (const s of SCHEMES) {
      const vars = syntaxVars(s.syntax);
      expect(Object.keys(vars).length, s.id).toBe(referenced.size);
    }
  });
});
