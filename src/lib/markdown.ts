/**
 * Minimal markdown for canvas notes.
 *
 * Not a markdown parser — just enough for a sticky note to look like a
 * sticky note when nobody is editing: heading, list, task, bold, italic,
 * strike, highlight, code, link, quote and rule. Deliberately no dependency:
 * the whole app fits in a stylesheet, and a full parser would weigh more
 * than the feature.
 *
 * The output is a data tree (not HTML): `NoteBody.tsx` paints it, so
 * there is no `dangerouslySetInnerHTML` path with text an agent wrote.
 *
 * Every block carries the `line` it started on. That is what lets the reading
 * view be interactive without becoming an editor: clicking a checkbox tells
 * the canvas *which source line* to flip, and nothing has to guess by
 * counting blocks (a fenced block eats many lines and would break the count).
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string }
  | { t: "code"; v: string }
  | { t: "strike"; v: string }
  | { t: "mark"; v: string }
  | { t: "link"; v: string; href: string }
  /** `![alt](src)`. `src` is relative to the project root, http(s) or data:. */
  | { t: "img"; alt: string; src: string };

/** Column alignment of a table, read off the `:---:` row. */
export type CellAlign = "left" | "center" | "right";

export type Block =
  | { t: "h"; level: 1 | 2 | 3; parts: Inline[]; line: number }
  | { t: "p"; parts: Inline[]; line: number }
  | {
      t: "li";
      ordered: boolean;
      marker: string;
      parts: Inline[];
      /** Nesting level, one per two leading spaces. Capped so a runaway
          indent cannot push the text out of the note. */
      depth: number;
      /** Present only on `- [ ]` / `- [x]` lines. */
      task?: "todo" | "done";
      line: number;
    }
  | { t: "quote"; parts: Inline[]; line: number }
  | { t: "pre"; v: string; lang?: string; line: number }
  | { t: "hr"; line: number }
  | {
      t: "table";
      /** Header cells, already parsed as inline. */
      head: Inline[][];
      /** Body rows, padded to the header's width. */
      rows: Inline[][][];
      align: CellAlign[];
      line: number;
    }
  | { t: "blank"; line: number };

const MAX_DEPTH = 5;

function depthOf(indent: string): number {
  return Math.min(MAX_DEPTH, Math.floor(indent.replace(/\t/g, "  ").length / 2));
}

/** Splits the text into blocks. Empty lines become spacers; they do not vanish. */
export function parseMarkdown(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const at = i;

    // Fenced code block: everything inside is literal. The word after the
    // fence is the language, kept as a label rather than a highlighter —
    // a note is not an editor.
    const fence = /^\s*```[ \t]*([\w+#.-]*)[ \t]*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // close the fence (or the text ran out)
      out.push({
        t: "pre",
        v: buf.join("\n"),
        line: at,
        ...(fence[1] ? { lang: fence[1] } : {}),
      });
      continue;
    }

    // A table is a header line, an alignment line and any number of body
    // lines. Both of the first two are required: a lone `| texto |` is a
    // sentence someone wrote with pipes in it, and promoting that to a
    // one-cell table would be a surprise nobody asked for.
    if (line.includes("|") && isAlignRow(lines[i + 1] ?? "")) {
      const head = splitRow(line);
      const align = alignOf(lines[i + 1], head.length);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        // Padded, never truncated: a short row is a typo, and dropping the
        // column would silently misalign everything to its right.
        while (cells.length < head.length) cells.push("");
        rows.push(cells.slice(0, head.length).map(parseInline));
        i++;
      }
      out.push({ t: "table", head: head.map(parseInline), rows, align, line: at });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ t: "hr", line: at });
      i++;
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({
        t: "h",
        level: h[1].length as 1 | 2 | 3,
        parts: parseInline(h[2]),
        line: at,
      });
      i++;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push({ t: "quote", parts: parseInline(quote[1]), line: at });
      i++;
      continue;
    }

    // Before the plain bullet: `- [ ] x` is a bullet too, and whichever
    // rule runs first wins.
    const task = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]?(.*)$/.exec(line);
    if (task) {
      out.push({
        t: "li",
        ordered: false,
        marker: "",
        task: task[2] === " " ? "todo" : "done",
        depth: depthOf(task[1]),
        parts: parseInline(task[3]),
        line: at,
      });
      i++;
      continue;
    }

    const bullet = /^([ \t]*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push({
        t: "li",
        ordered: false,
        marker: "•",
        depth: depthOf(bullet[1]),
        parts: parseInline(bullet[2]),
        line: at,
      });
      i++;
      continue;
    }

    const ord = /^([ \t]*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ord) {
      out.push({
        t: "li",
        ordered: true,
        marker: `${ord[2]}.`,
        depth: depthOf(ord[1]),
        parts: parseInline(ord[3]),
        line: at,
      });
      i++;
      continue;
    }

    if (!line.trim()) {
      out.push({ t: "blank", line: at });
      i++;
      continue;
    }

    out.push({ t: "p", parts: parseInline(line), line: at });
    i++;
  }
  return out;
}

/**
 * The cells of one table line.
 *
 * No escaping of `\|`: this is the *note's* parser, and a document gets the
 * full one (`lib/mddoc.ts`). A pipe inside a cell is rare enough that "put it
 * in backticks" is a fair answer, and the alternative is a state machine in a
 * file whose whole point is that it is small.
 */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Is this the `| --- | :--: |` line that turns the one above it into a table? */
function isAlignRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function alignOf(line: string, width: number): CellAlign[] {
  const cells = splitRow(line);
  const out: CellAlign[] = [];
  for (let i = 0; i < width; i++) {
    const c = cells[i] ?? "";
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    out.push(left && right ? "center" : right ? "right" : "left");
  }
  return out;
}

// `code` first: what is between backticks does not become bold or italic.
// The link comes next so a URL full of underscores is not read as italics.
// Two-character markers always before their one-character prefix.
const INLINE_RE =
  /(`[^`]+`)|(!\[[^\]\n]*\]\([^)\s]*\))|(\[[^\]\n]*\]\([^)\s]*\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~\n]+~~)|(==[^=\n]+==)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

const LINK_RE = /^\[([^\]\n]*)\]\(([^)\s]*)\)$/;
const IMG_RE = /^!\[([^\]\n]*)\]\(([^)\s]*)\)$/;

/**
 * What a note is allowed to **show**.
 *
 * Wider than `safeHref` in one direction and narrower in another: a bare
 * relative path is the common case (a note points at a screenshot inside the
 * project, and the body resolves it against the project root), an embedded
 * `data:image/…` is what a pasted print becomes — and anything else carrying a
 * scheme is refused. Note text arrives from agents through the CLI bridge, so
 * a `javascript:` here is untrusted input, not a picture.
 */
export function safeImgSrc(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^data:image\/[\w.+-]+;base64,/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? null : s;
}

/**
 * What a note is allowed to point at.
 *
 * Note text arrives from agents through the CLI bridge, so an `href` is
 * untrusted input: anything with a scheme that is not http(s) is refused and
 * falls back to plain text. `host:3000` survives — that is a port, not a
 * scheme, and a local dev server is the most linked thing in this app.
 */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (scheme && !/^https?:\/\//i.test(s) && !/^[\w.-]+:\d+/.test(s)) return null;
  return s;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  for (;;) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) break;
    const tok = m[0];
    const img = tok.startsWith("![") ? IMG_RE.exec(tok) : null;
    if (img) {
      const src = safeImgSrc(img[2]);
      // A refused picture is not markup: the raw text stays exactly as typed,
      // like a refused link, and the scan carries on past it.
      if (!src) {
        out.push({ t: "text", v: rest.slice(0, m.index + tok.length) });
        rest = rest.slice(m.index + tok.length);
        continue;
      }
      if (m.index > 0) out.push({ t: "text", v: rest.slice(0, m.index) });
      out.push({ t: "img", alt: img[1], src });
      rest = rest.slice(m.index + tok.length);
      continue;
    }
    const link = tok.startsWith("[") ? LINK_RE.exec(tok) : null;
    const href = link ? safeHref(link[2]) : null;
    // A refused link is not markup: leave the raw text in place and keep
    // scanning after it, or the `[` would match again forever.
    if (link && !href) {
      out.push({ t: "text", v: rest.slice(0, m.index + tok.length) });
      rest = rest.slice(m.index + tok.length);
      continue;
    }
    if (m.index > 0) out.push({ t: "text", v: rest.slice(0, m.index) });
    if (link && href) out.push({ t: "link", v: link[1] || href, href });
    else if (tok.startsWith("`")) out.push({ t: "code", v: tok.slice(1, -1) });
    else if (tok.startsWith("**") || tok.startsWith("__"))
      out.push({ t: "strong", v: tok.slice(2, -2) });
    else if (tok.startsWith("~~")) out.push({ t: "strike", v: tok.slice(2, -2) });
    else if (tok.startsWith("==")) out.push({ t: "mark", v: tok.slice(2, -2) });
    else out.push({ t: "em", v: tok.slice(1, -1) });
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) out.push({ t: "text", v: rest });
  return out;
}
