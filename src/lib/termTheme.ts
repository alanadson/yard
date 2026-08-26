/**
 * The terminal's two ANSI palettes.
 *
 * xterm paints on a canvas: no CSS token reaches it, so the well needs a
 * palette per appearance. Both keep the ANSI semantics (blue stays blue,
 * red stays red — a CLI's colors *mean* something) and both commit to the
 * floors `termTheme.test.ts` checks: body text at 7:1 over the well, every
 * hue at 3:1. The color-scheme extensions (`lib/colorSchemes.ts`) still win
 * over either when one is enabled.
 */
import type { TermPalette } from "./colorSchemes";
import type { ResolvedTheme } from "./theme";

// Dark premium theme, matching the chrome (styles.css): the background is the
// panel's terminal well (#121215), cursor and selection in system blue. ANSI
// colors keep their semantics, tuned for the cold ground without shouting
// over it.
export const DARK_TERM: TermPalette = {
  background: "#121215",
  foreground: "#d9d9de",
  cursor: "#8ec2ff",
  cursorAccent: "#121215",
  selectionBackground: "#2b446b",
  black: "#1d1d22",
  red: "#ff6e64",
  green: "#5bd57f",
  yellow: "#eac95c",
  blue: "#5fa8ff",
  magenta: "#c98bf2",
  cyan: "#5fd2d2",
  white: "#d9d9de",
  brightBlack: "#7a7a85",
  brightRed: "#ff958d",
  brightGreen: "#8ce3a4",
  brightYellow: "#f2da8a",
  brightBlue: "#8fc2ff",
  brightMagenta: "#dcb0f7",
  brightCyan: "#8ce0e0",
  brightWhite: "#f7f7f9",
};

// Paper well for the light appearance: near-white ground, graphite ink, and
// the hues one step deeper than a screen palette — a `yellow` that reads on a
// dark well is invisible on paper, and the CLIs' warnings ride on it.
export const LIGHT_TERM: TermPalette = {
  background: "#fafafc",
  foreground: "#1f2028",
  cursor: "#0a5fc4",
  cursorAccent: "#ffffff",
  selectionBackground: "#bcd6ff",
  black: "#1d1d22",
  red: "#c62828",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0a5fc4",
  magenta: "#8e24aa",
  cyan: "#0e7c86",
  white: "#e6e6ea",
  brightBlack: "#6b6b76",
  brightRed: "#d32f2f",
  brightGreen: "#2e7d32",
  brightYellow: "#b26a00",
  brightBlue: "#1976d2",
  brightMagenta: "#ab47bc",
  brightCyan: "#00838f",
  brightWhite: "#ffffff",
};

/** The well's palette for the appearance on screen. */
export function termThemeFor(resolved: ResolvedTheme): TermPalette {
  return resolved === "light" ? LIGHT_TERM : DARK_TERM;
}
