/**
 * The terminal well paints its own pixels: no CSS token reaches xterm. So the
 * light appearance needs a second ANSI palette, and the thing that can go
 * wrong is silent — a `yellow` that reads on a dark well vanishes on a light
 * one, and the CLI's warnings with it. These are the floors both palettes
 * commit to.
 */
import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast";
import { DARK_TERM, LIGHT_TERM, termThemeFor } from "./termTheme";

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
