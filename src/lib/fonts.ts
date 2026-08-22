/**
 * Chosen fonts, applied to the window.
 *
 * The preferences store a *family name* picked from the installed list (or an
 * empty string for "the Yard default"). Turning that into pixels happens here:
 * the interface and code fonts become CSS variables on `<html>` — inline, so
 * they override the `:root` defaults in `styles.css` — and the ligature
 * switch becomes `--code-liga`, consumed by the code surfaces (editor, diffs,
 * `code`/`pre`). The terminal is canvas-drawn and takes its font through
 * xterm's own options (see `XTermView`), not through CSS.
 */
import type { Prefs } from "../stores/uiStore";

/** Fallbacks appended after the chosen family, per surface. */
const UI_FALLBACK =
  '"Inter Variable", "SF Pro Text", -apple-system, "Segoe UI Variable Text", ' +
  '"Segoe UI", system-ui, sans-serif';
const CODE_FALLBACK = '"Cascadia Mono", Consolas, ui-monospace, monospace';
export const TERM_FALLBACK = "Consolas, monospace";

/** First family of a CSS stack, unquoted — what the picker shows as selected. */
export function familyFromStack(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

/** Family name → CSS stack. Always quoted: names with spaces/digits stay valid. */
export function stackFrom(family: string, fallback: string): string {
  const clean = family.trim().replace(/["']/g, "");
  return clean ? `"${clean}", ${fallback}` : fallback;
}

/**
 * Pushes the font preferences into the document. Empty family = remove the
 * inline override and let the `styles.css` default show through.
 */
export function applyFontPrefs(
  prefs: Pick<Prefs, "uiFontFamily" | "codeFontFamily" | "codeLigatures">,
): void {
  const root = document.documentElement.style;
  if (prefs.uiFontFamily) root.setProperty("--ui-font", stackFrom(prefs.uiFontFamily, UI_FALLBACK));
  else root.removeProperty("--ui-font");
  if (prefs.codeFontFamily)
    root.setProperty("--mono", stackFrom(prefs.codeFontFamily, CODE_FALLBACK));
  else root.removeProperty("--mono");
  if (prefs.codeLigatures) root.removeProperty("--code-liga");
  else root.setProperty("--code-liga", "none");
}
