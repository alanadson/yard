/**
 * Minimal markdown for canvas notes.
 *
 * Not a markdown parser — just enough for a sticky note to look like a
 * sticky note when nobody is editing: heading, list, bold, italic, code,
 * quote and rule. Deliberately no dependency: the whole app fits in a
 * stylesheet, and a full parser would weigh more than the feature.
 *
 * The output is a data tree (not HTML): `NoteBody.tsx` paints it, so
 * there is no `dangerouslySetInnerHTML` path with text an agent wrote.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string }
  | { t: "code"; v: string };

export type Block =
  | { t: "h"; level: 1 | 2 | 3; parts: Inline[] }
  | { t: "p"; parts: Inline[] }
  | { t: "li"; ordered: boolean; marker: string; parts: Inline[] }
  | { t: "quote"; parts: Inline[] }
  | { t: "pre"; v: string }
  | { t: "hr" }
  | { t: "blank" };

/** Splits the text into blocks. Empty lines become spacers; they do not vanish. */
export function parseMarkdown(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: everything inside is literal.
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // close the fence (or the text ran out)
      out.push({ t: "pre", v: buf.join("\n") });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({
        t: "h",
        level: h[1].length as 1 | 2 | 3,
        parts: parseInline(h[2]),
      });
      i++;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push({ t: "quote", parts: parseInline(quote[1]) });
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push({ t: "li", ordered: false, marker: "•", parts: parseInline(bullet[1]) });
      i++;
      continue;
    }

    const ord = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ord) {
      out.push({ t: "li", ordered: true, marker: `${ord[1]}.`, parts: parseInline(ord[2]) });
      i++;
      continue;
    }

    if (!line.trim()) {
      out.push({ t: "blank" });
      i++;
      continue;
    }

    out.push({ t: "p", parts: parseInline(line) });
    i++;
  }
  return out;
}

// `code` first: what is between backticks does not become bold or italic.
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  for (;;) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) out.push({ t: "text", v: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ t: "code", v: tok.slice(1, -1) });
    else if (tok.startsWith("**") || tok.startsWith("__"))
      out.push({ t: "strong", v: tok.slice(2, -2) });
    else out.push({ t: "em", v: tok.slice(1, -1) });
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) out.push({ t: "text", v: rest });
  return out;
}
