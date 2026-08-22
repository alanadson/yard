/**
 * Shine — syntax colors for code that lives *outside* an editor.
 *
 * The markdown preview and the diff viewer both show code as plain React
 * trees: no CodeMirror instance, no HTML injection, just text. This module
 * runs the same grammars the editor uses (`languages.ts`) over that text and
 * hands back inert data — chunks of `{text, cls}` — for the caller to paint.
 * The classes are `classHighlighter`'s `tok-*` names, colored in `styles.css`
 * with the same palette as `yardHighlight`, so a line of Rust reads the same
 * in the editor, in a README fence and in a diff.
 */
import type { ReactNode } from "react";
import type { LanguageSupport } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";

export interface ShineChunk {
  text: string;
  /** `tok-*` class names, or `null` where the grammar saw nothing special. */
  cls: string | null;
}

/**
 * Highlights a whole text, returning one chunk list per line.
 *
 * Parsing happens on the full string — not line by line — so multi-line
 * constructs (block comments, template strings) color correctly; the split
 * into lines is only in the output, which is what a diff needs to reassemble
 * per-row.
 */
export function shineLines(text: string, support: LanguageSupport): ShineChunk[][] {
  const tree = support.language.parser.parse(text);
  const lines: ShineChunk[][] = [];
  let cur: ShineChunk[] = [];
  highlightCode(
    text,
    tree,
    classHighlighter,
    (chunk, classes) => cur.push({ text: chunk, cls: classes || null }),
    () => {
      lines.push(cur);
      cur = [];
    },
  );
  lines.push(cur);
  return lines;
}

/** The chunks of one line, cut to `[from, to)` in character positions. */
export function sliceChunks(chunks: ShineChunk[], from: number, to: number): ShineChunk[] {
  const out: ShineChunk[] = [];
  let pos = 0;
  for (const c of chunks) {
    const start = Math.max(from - pos, 0);
    const end = Math.min(to - pos, c.text.length);
    if (end > start) out.push({ text: c.text.slice(start, end), cls: c.cls });
    pos += c.text.length;
  }
  return out;
}

/** Chunks to React — spans only where there is a class to carry. */
export function chunkNodes(chunks: ShineChunk[]): ReactNode {
  return chunks.map((c, i) =>
    c.cls ? (
      <span key={i} className={c.cls}>
        {c.text}
      </span>
    ) : (
      c.text
    ),
  );
}
