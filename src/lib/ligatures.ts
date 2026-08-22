/**
 * Where programming ligatures live inside a run of terminal text.
 *
 * xterm's canvas/WebGL renderers paint one cell at a time, which splits `=>`
 * into two draws and no font ever gets the chance to substitute the arrow.
 * A *character joiner* fixes that: it hands the renderer ranges to paint as a
 * single string, and the font's own `calt`/`liga` rules do the rest. The real
 * ligature addon parses the font file to know its rules; that needs the
 * filesystem, which a WebView does not have — so this is the honest subset:
 * the sequences that every coding font (Fira Code, Cascadia Code, JetBrains
 * Mono, Iosevka…) agrees on. A font without ligatures simply draws the same
 * characters joined, which looks identical to not joining at all.
 */

/** Longest-first inside each group, so `===` wins over `==` wins over `=`. */
const SEQUENCES = new RegExp(
  [
    "<==>", "<=>", "<->", "-->", "==>", "<--", "<==",
    "=>", "->", "<-",
    "===", "!==", "==", "!=", "<=", ">=",
    "&&", "\\|\\|", "\\?\\?", "\\?\\.",
    "::", "\\.\\.\\.", "\\.\\.",
    "\\+\\+", "--",
    "<<", ">>", "<>", "\\|>", "<\\|",
    "//", "/\\*", "\\*/", "##", "~~", "=~", "!~",
  ].join("|"),
  "g",
);

/**
 * Joiner in the shape `registerCharacterJoiner` expects: text of a
 * same-attribute run in, `[start, end)` index pairs out.
 */
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  SEQUENCES.lastIndex = 0;
  for (let m = SEQUENCES.exec(text); m; m = SEQUENCES.exec(text)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
