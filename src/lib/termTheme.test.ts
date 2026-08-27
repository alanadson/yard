/**
 * The terminal well paints its own pixels: no CSS token reaches xterm. So the
 * light appearance needs a second ANSI palette, and the thing that can go
 * wrong is silent — a `yellow` that reads on a dark well vanishes on a light
 * one, and the CLI's warnings with it. These are the floors both palettes
 * commit to.
 */
import { describe, expect, it } from "vitest";

import { schemeFor } from "./colorSchemes";
import { contrastRatio } from "./contrast";
import {
  DARK_TERM,
  LIGHT_TERM,
  TERM_WELL_VAR,
  termPaletteFor,
  termThemeFor,
} from "./termTheme";

// The two sheets that paint the host the canvas sits in.
import darkCss from "../styles.css?raw";
import lightCss from "../theme-light.css?raw";

const ANSI = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
const BRIGHT = {
  red: "brightRed",
  green: "brightGreen",
  yellow: "brightYellow",
  blue: "brightBlue",
  magenta: "brightMagenta",
  cyan: "brightCyan",
} as const;

describe("termThemeFor", () => {
  it("hands out the palette of the resolved appearance", () => {
    expect(termThemeFor("dark")).toBe(DARK_TERM);
    expect(termThemeFor("light")).toBe(LIGHT_TERM);
  });
});

describe("the light palette", () => {
  it("keeps body text at 7:1 over the well, like the dark one", () => {
    expect(contrastRatio(LIGHT_TERM.foreground, LIGHT_TERM.background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(DARK_TERM.foreground, DARK_TERM.background)).toBeGreaterThanOrEqual(7);
  });

  it("every ANSI hue stays readable over the well (≥ 3:1), normal and bright", () => {
    for (const hue of ANSI) {
      const bright = BRIGHT[hue];
      expect(contrastRatio(LIGHT_TERM[hue], LIGHT_TERM.background), hue).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(LIGHT_TERM[bright], LIGHT_TERM.background), bright).toBeGreaterThanOrEqual(3);
    }
    // "black" is the ink of a light well; "white" is close to the paper on
    // purpose (it plays the part `black` plays on the dark side).
    expect(contrastRatio(LIGHT_TERM.black, LIGHT_TERM.background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(LIGHT_TERM.brightBlack, LIGHT_TERM.background)).toBeGreaterThanOrEqual(3);
  });

  it("the cursor is visible over the paper and the paper's text over the cursor", () => {
    expect(contrastRatio(LIGHT_TERM.cursor, LIGHT_TERM.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(LIGHT_TERM.cursorAccent, LIGHT_TERM.cursor)).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The seam nothing was watching. `.xterm-host` paints `--well-code` and xterm
 * paints its own `background` on a canvas an inch above it — two numbers, in
 * two languages, that have to be the same colour or the terminal wears a halo
 * of the wrong black around its own text.
 *
 * They were kept in sync by a sentence in the header of `termTheme.ts` ("the
 * background is the panel's terminal well (#121215)"), which is the same kind
 * of promise `contrast.ts` was written because comments cannot keep. It came
 * due when the well went to pure black for the YouTube-strength dark and the
 * palette stayed at #121215.
 */
describe("the well the palette paints and the well the CSS paints", () => {
  /** `--well-code` as declared from `scope` onwards — the first one wins. */
  const wellOf = (css: string, scope: RegExp): string => {
    const at = css.search(scope);
    expect(at, `the ${scope.source} block is gone`).toBeGreaterThan(-1);
    const declared = /--well-code:\s*([^;]+);/.exec(css.slice(at));
    expect(declared, "nothing declares --well-code after it").not.toBeNull();
    return declared![1].trim().toLowerCase();
  };

  it("reads the declaration and not the sentence about it", () => {
    expect(wellOf("/* the well is #ffffff */\n:root { --well-code: #123456; }", /:root\s*\{/)).toBe("#123456");
  });

  it.each([
    ["dark", DARK_TERM, () => wellOf(darkCss, /:root\s*\{/)],
    ["light", LIGHT_TERM, () => wellOf(lightCss, /:root\[data-theme="light"\]\s*\{/)],
  ])("the %s palette opens on the same well the sheet paints behind it", (_name, palette, well) => {
    expect(palette.background.toLowerCase()).toBe(well());
  });

  /**
   * And the block cursor inverts: the glyph under it is drawn in
   * `cursorAccent`, so anything other than the well itself leaves a coloured
   * notch where the cursor sits.
   */
  it.each([
    ["dark", DARK_TERM],
    ["light", LIGHT_TERM],
  ])("the %s cursor punches the well's own colour through the glyph", (_name, palette) => {
    expect(palette.cursorAccent.toLowerCase()).toBe(palette.background.toLowerCase());
  });
});

/**
 * The same seam, reopened by the Extensions store. A colour-scheme extension
 * replaces the terminal's whole palette — Ayu opens on `#0b0e14`, GitHub Dark
 * on `#0d1117` — and `--well-code` stayed at the appearance's pure black. The
 * gutter `.xterm-host` paints around the canvas is *inside* the well, so the
 * terminal wore an 8 px black frame down its left edge (and a 6 px one over
 * the first row) that no token in the sheet could follow.
 *
 * The fix is one name: the palette on screen is chosen once, in
 * `termPaletteFor`, and its background is written onto the host as
 * `TERM_WELL_VAR` — so the gutter and the canvas can only ever open on the
 * same colour.
 */
describe("the well under a colour-scheme extension", () => {
  it("opens on the enabled scheme's background, whatever the appearance", () => {
    const ayu = schemeFor("theme-ayu");
    expect(ayu, "the Ayu scheme is gone from the store").toBeDefined();
    expect(termPaletteFor("theme-ayu", "dark")).toBe(ayu!.term);
    expect(termPaletteFor("theme-ayu", "light")).toBe(ayu!.term);
  });

  it("falls back to the appearance's own palette with no scheme on", () => {
    expect(termPaletteFor(undefined, "dark")).toBe(DARK_TERM);
    expect(termPaletteFor(undefined, "light")).toBe(LIGHT_TERM);
  });

  /** The `.xterm-host` rule's `background`, as declared in the sheet. */
  const gutterOf = (css: string): string => {
    const at = css.search(/^\.xterm-host \{/m);
    expect(at, "the .xterm-host rule is gone").toBeGreaterThan(-1);
    const declared = /background:\s*([^;]+);/.exec(css.slice(at));
    expect(declared, "the well paints nothing").not.toBeNull();
    return declared![1].trim();
  };

  it("is painted from the palette the terminal opened, not from a fixed token", () => {
    expect(gutterOf(darkCss)).toBe(`var(${TERM_WELL_VAR}, var(--well-code))`);
  });
});
