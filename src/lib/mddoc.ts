/**
 * Markdown for **documents** — the grammar behind the editor's preview.
 *
 * `markdown.ts` is the note's parser: line by line, no nesting, deliberately
 * small because a sticky note is a sticky note. A README is not. The files
 * this app edits carry tables, nested lists, fenced code with a language,
 * images, reference links and footnotes, and a parser that flattens all of
 * that would show the user something other than what ships.
 *
 * So this is a second, fuller parser, and the split is on purpose:
 * - the note pays nothing for a grammar it never uses (it re-parses on every
 *   frame of a drag);
 * - the document gets containers — a quote holds blocks, an item holds
 *   blocks, a list holds items — which is what "nesting" means and what the
 *   note's flat list of lines can never express.
 *
 * As in `markdown.ts`, the output is a **data tree, not HTML**: the preview
 * paints it with React, so there is no `dangerouslySetInnerHTML` anywhere
 * near text an agent wrote. Raw HTML in the source shows as its own source.
 *
 * Every block carries the source `line` it started on. That is what makes the
 * preview live: clicking a checkbox flips *that* line, the outline jumps to
 * *that* line, and the split view scrolls to the block the caret is in.
 */

import { safeHref } from "./markdown";

// ---------------------------------------------------------------------------
// the tree
// ---------------------------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; parts: Inline[] }
  | { t: "em"; parts: Inline[] }
  | { t: "strike"; parts: Inline[] }
  | { t: "mark"; parts: Inline[] }
  | { t: "sub"; parts: Inline[] }
  | { t: "sup"; parts: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; parts: Inline[]; href: string; title?: string }
  | { t: "image"; alt: string; src: string; title?: string }
  /** `[^1]` — the number is what the reader clicks. */
  | { t: "noteref"; id: string }
  /** A hard line break (two trailing spaces, or a trailing `\`). */
  | { t: "br" };

export interface Cell {
  parts: Inline[];
}

export type Align = "left" | "center" | "right" | null;

export interface Item {
  blocks: Block[];
  /** Present only on `- [ ]` / `- [x]` items. */
  task?: "todo" | "done";
  /** Source line of the marker — what a checkbox click has to flip. */
  line: number;
}

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; parts: Inline[]; slug: string; line: number }
  | { t: "p"; parts: Inline[]; line: number }
  | { t: "code"; text: string; lang?: string; line: number }
  | { t: "quote"; blocks: Block[]; line: number }
  | {
      t: "list";
      ordered: boolean;
      /** First number of an ordered list — `3.` starts at three. */
      start: number;
      /** No blank line between items: renders without paragraph spacing. */
      tight: boolean;
      items: Item[];
      line: number;
    }
  | { t: "table"; head: Cell[]; rows: Cell[][]; align: Align[]; line: number }
  | { t: "hr"; line: number }
  /** Raw HTML, shown as source: this preview never executes what it reads. */
  | { t: "html"; text: string; line: number }
  /** `[^1]: …` — the footnote's own text, rendered at the foot. */
  | { t: "note"; id: string; blocks: Block[]; line: number };

/** `[label]: url "title"`, collected before parsing so `[text][label]` resolves. */
export type LinkDefs = Record<string, { href: string; title?: string }>;

interface Line {
  text: string;
  /** Zero-based, as in the editor's document. */
  n: number;
}

// ---------------------------------------------------------------------------
// line shapes
// ---------------------------------------------------------------------------

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\n]*)$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_QUOTE = /^ {0,3}>[ \t]?/;
const RE_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const RE_TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_DELIM = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const RE_DEF = /^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+["'(](.*)["')])?[ \t]*$/;
const RE_NOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const RE_HTML = /^ {0,3}<(\/?[a-zA-Z][\w-]*|!--)/;

/** A line that would end a paragraph by starting something else. */
function startsBlock(text: string): boolean {
  return (
    RE_FENCE.test(text) ||
    RE_ATX.test(text) ||
    RE_HR.test(text) ||
    RE_QUOTE.test(text) ||
    RE_ITEM.test(text) ||
    RE_NOTE_DEF.test(text) ||
    RE_HTML.test(text)
  );
}

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

/**
 * Parses the whole text.
 *
 * Two passes and no more: the first lifts out the link definitions (they are
 * invisible in the output but resolve `[text][label]` anywhere, including
 * *above* where they are written), the second reads the blocks.
 */
export function parseDoc(src: string): Block[] {
  const raw = src.split("\n");
  const defs: LinkDefs = {};
  const lines: Line[] = [];
  const head: Block[] = [];

  // Front matter: `---` on the very first line, closed by another `---`.
  // Without this it reads as a rule, a paragraph of `chave: valor` and a
  // second rule — three blocks of noise on top of half the docs in a repo.
  let from = 0;
  if (raw[0]?.trim() === "---") {
    const close = raw.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (close > 0) {
      head.push({
        t: "code",
        text: raw.slice(1, close).join("\n"),
        lang: "yaml",
        line: 0,
      });
      from = close + 1;
    }
  }

  // A definition only counts outside a fence — inside, `[a]: b` is code.
  let fence: string | null = null;
  for (let i = from; i < raw.length; i++) {
    const text = raw[i];
    const f = RE_FENCE.exec(text);
    if (fence) {
      if (f && f[1].startsWith(fence[0]) && f[1].length >= fence.length) fence = null;
      lines.push({ text, n: i });
      continue;
    }
    if (f) {
      fence = f[1];
      lines.push({ text, n: i });
      continue;
    }
    const def = RE_DEF.exec(text);
    if (def && !RE_NOTE_DEF.test(text)) {
      const href = safeHref(def[2]);
      // A refused address is not a definition: keeping the line visible is
      // more honest than a link that silently goes nowhere.
      if (href) {
        defs[def[1].toLowerCase()] = { href, ...(def[3] ? { title: def[3] } : {}) };
        continue;
      }
    }
    lines.push({ text, n: i });
  }

  const blocks = [...head, ...readBlocks(lines, defs)];
  applySlugs(blocks);
  return blocks;
}

/** Anchors: unique per document, so two "Instalação" do not fight. */
function applySlugs(blocks: Block[]): void {
  const seen = new Map<string, number>();
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === "h") {
        const base = slugify(plain(b.parts)) || "titulo";
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        b.slug = n === 0 ? base : `${base}-${n}`;
      } else if (b.t === "quote" || b.t === "note") {
        walk(b.blocks);
      } else if (b.t === "list") {
        for (const item of b.items) walk(item.blocks);
      }
    }
  };
  walk(blocks);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    // Combining accents, dropped after the decomposition above: "Instalação"
    // and "Instalacao" have to reach the same anchor.
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readBlocks(lines: Line[], defs: LinkDefs): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const text = line.text;

    if (!text.trim()) {
      i++;
      continue;
    }

    // --- fenced code ---
    const fence = RE_FENCE.exec(text);
    if (fence) {
      const mark = fence[1];
      const lang = fence[2].trim().split(/\s+/)[0] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const f = RE_FENCE.exec(lines[i].text);
        if (f && f[1][0] === mark[0] && f[1].length >= mark.length && !f[2].trim()) {
          i++;
          break;
        }
        body.push(lines[i].text);
        i++;
      }
      out.push({ t: "code", text: body.join("\n"), lang, line: line.n });
      continue;
    }

    // --- rule --- (before the list: `- - -` is a rule, not three items)
    if (RE_HR.test(text)) {
      out.push({ t: "hr", line: line.n });
      i++;
      continue;
    }

    // --- heading ---
    const atx = RE_ATX.exec(text);
    if (atx) {
      out.push({
        t: "h",
        level: atx[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        parts: parseInline(atx[2] ?? "", defs),
        slug: "",
        line: line.n,
      });
      i++;
      continue;
    }

    // --- footnote definition ---
    const noteDef = RE_NOTE_DEF.exec(text);
    if (noteDef) {
      const body: Line[] = [{ text: noteDef[2], n: line.n }];
      i++;
      // Continuation lines are indented, as in any other markdown container.
      while (i < lines.length && (/^ {2,}\S/.test(lines[i].text) || !lines[i].text.trim())) {
        if (!lines[i].text.trim() && !(i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1].text))) {
          break;
        }
        body.push({ text: lines[i].text.replace(/^ {1,4}/, ""), n: lines[i].n });
        i++;
      }
      out.push({ t: "note", id: noteDef[1], blocks: readBlocks(body, defs), line: line.n });
      continue;
    }

    // --- blockquote ---
    if (RE_QUOTE.test(text)) {
      const inner: Line[] = [];
      while (i < lines.length) {
        const cur = lines[i].text;
        if (RE_QUOTE.test(cur)) {
          inner.push({ text: cur.replace(RE_QUOTE, ""), n: lines[i].n });
          i++;
          continue;
        }
        // Lazy continuation: a plain line right under a quoted one belongs to
        // the quote's paragraph, which is how everybody actually writes them.
        if (cur.trim() && !startsBlock(cur)) {
          inner.push({ text: cur, n: lines[i].n });
          i++;
          continue;
        }
        break;
      }
      out.push({ t: "quote", blocks: readBlocks(inner, defs), line: line.n });
      continue;
    }

    // --- table ---
    if (text.includes("|") && i + 1 < lines.length && RE_DELIM.test(lines[i + 1].text)) {
      const align = splitRow(lines[i + 1].text).map((c): Align => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      });
      const head = splitRow(text).map((c) => ({ parts: parseInline(c, defs) }));
      i += 2;
      const rows: Cell[][] = [];
      while (i < lines.length && lines[i].text.includes("|") && lines[i].text.trim()) {
        const cells = splitRow(lines[i].text).map((c) => ({ parts: parseInline(c, defs) }));
        // Ragged rows are common in hand-written tables; pad so the columns
        // do not shift under the header.
        while (cells.length < head.length) cells.push({ parts: [] });
        rows.push(cells.slice(0, Math.max(head.length, 1)));
        i++;
      }
      out.push({ t: "table", head, rows, align, line: line.n });
      continue;
    }

    // --- list ---
    if (RE_ITEM.test(text)) {
      const [list, next] = readList(lines, i, defs);
      out.push(list);
      i = next;
      continue;
    }

    // --- raw HTML ---
    if (RE_HTML.test(text)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].text.trim()) {
        body.push(lines[i].text);
        i++;
      }
      out.push({ t: "html", text: body.join("\n"), line: line.n });
      continue;
    }

    // --- indented code ---
    if (/^ {4,}\S/.test(text)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i].text) || !lines[i].text.trim())) {
        if (!lines[i].text.trim()) {
          // A trailing blank line belongs to the document, not to the block.
          const ahead = lines.findIndex((l, k) => k > i && l.text.trim());
          if (ahead < 0 || !/^ {4,}/.test(lines[ahead].text)) break;
        }
        body.push(lines[i].text.slice(4));
        i++;
      }
      out.push({ t: "code", text: body.join("\n").replace(/\n+$/, ""), line: line.n });
      continue;
    }

    // --- paragraph (and setext heading) ---
    const buf: string[] = [text];
    i++;
    let setext: 1 | 2 | null = null;
    while (i < lines.length) {
      const cur = lines[i].text;
      if (!cur.trim()) break;
      const under = RE_SETEXT.exec(cur);
      // `---` under text is a heading; `-` alone would have been a list item
      // and never gets here, and `***` was already read as a rule.
      if (under && !RE_ITEM.test(cur)) {
        setext = under[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (startsBlock(cur) || (cur.includes("|") && i + 1 < lines.length && RE_DELIM.test(lines[i + 1].text))) {
        break;
      }
      buf.push(cur);
      i++;
    }
    const joined = buf.join("\n");
    if (setext) {
      out.push({
        t: "h",
        level: setext,
        parts: parseInline(joined, defs),
        slug: "",
        line: line.n,
      });
    } else {
      out.push({ t: "p", parts: parseInline(joined, defs), line: line.n });
    }
  }

  return out;
}

/** Cells of one table row, `\|` inside a cell staying a pipe. */
function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "\\" && trimmed[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "|") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/**
 * One list, from the first item to the last one at the same level.
 *
 * The item's content is everything indented past its marker — that is what
 * makes a nested list nested, and a second paragraph inside an item possible.
 * Items are read into their own line arrays and parsed by the same
 * `readBlocks`, so anything a document can hold, an item can hold too.
 */
function readList(lines: Line[], from: number, defs: LinkDefs): [Block, number] {
  const first = RE_ITEM.exec(lines[from].text);
  if (!first) throw new Error("readList with no item");
  const ordered = /\d/.test(first[2]);
  const start = ordered ? Number(first[2].slice(0, -1)) : 1;
  const items: Item[] = [];
  let tight = true;
  let i = from;
  let blankBefore = false;

  while (i < lines.length) {
    const m = RE_ITEM.exec(lines[i].text);
    if (!m) break;
    // A different kind of marker starts a *new* list, not another item.
    if (/\d/.test(m[2]) !== ordered) break;
    if (blankBefore) tight = false;

    const marker = m[1].length + m[2].length + (m[3] || " ").length;
    const rest = lines[i].text.slice(m[0].length);
    const task = RE_TASK.exec(rest);
    const body: Line[] = [
      { text: task ? rest.slice(task[0].length) : rest, n: lines[i].n },
    ];
    const itemLine = lines[i].n;
    i++;

    // The item's own lines: indented past the marker, or blank (a blank line
    // only ends the item when what follows is not indented either).
    while (i < lines.length) {
      const cur = lines[i].text;
      if (!cur.trim()) {
        const ahead = lines.findIndex((l, k) => k > i && l.text.trim());
        const continues =
          ahead >= 0 && new RegExp(`^ {${Math.min(marker, 8)},}\\S`).test(lines[ahead].text);
        if (!continues) {
          blankBefore = true;
          i++;
          break;
        }
        tight = false;
        body.push({ text: "", n: lines[i].n });
        i++;
        continue;
      }
      if (new RegExp(`^ {${Math.min(marker, 8)},}`).test(cur)) {
        body.push({ text: cur.slice(Math.min(marker, 8)), n: lines[i].n });
        i++;
        continue;
      }
      // Lazy continuation of the item's paragraph.
      if (!startsBlock(cur) && body.length && body[body.length - 1].text.trim()) {
        body.push({ text: cur, n: lines[i].n });
        i++;
        continue;
      }
      blankBefore = false;
      break;
    }

    items.push({
      blocks: readBlocks(body, defs),
      ...(task ? { task: task[1] === " " ? ("todo" as const) : ("done" as const) } : {}),
      line: itemLine,
    });

    // A blank line then something that is not an item closes the list.
    if (blankBefore) {
      const next = lines.findIndex((l, k) => k >= i && l.text.trim());
      if (next < 0 || !RE_ITEM.test(lines[next].text)) break;
      i = next;
    }
  }

  return [
    { t: "list", ordered, start, tight, items, line: lines[from].n },
    i,
  ];
}

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

const PUNCT = /[\\`*_{}[\]()#+\-.!~=<>|^"']/;
const RE_URL = /^(https?:\/\/|www\.)[^\s<>()[\]"']+[^\s<>()[\]"'.,;:!?]/i;
const WORD = /[\p{L}\p{N}]/u;

/**
 * The inline grammar, one scan, containers recursing into themselves —
 * `**text _with_ emphasis**` comes out nested, which is what a flat parser
 * (the note's) cannot do.
 */
export function parseInline(src: string, defs: LinkDefs = {}): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;

  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };

  while (i < src.length) {
    const c = src[i];

    // A backslash escape: the next character is literal, marker or not.
    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        push({ t: "br" });
        i += 2;
        continue;
      }
      if (next && PUNCT.test(next)) {
        text += next;
        i += 2;
        continue;
      }
    }

    // Soft wrap inside a paragraph: two trailing spaces (or the escape above)
    // are the only way markdown has to ask for a real line break.
    if (c === "\n") {
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, "");
        push({ t: "br" });
      } else {
        text += " ";
      }
      i++;
      continue;
    }

    if (c === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(run, i + run.length);
      if (close > 0) {
        push({ t: "code", v: src.slice(i + run.length, close).replace(/^ | $/g, "") });
        i = close + run.length;
        continue;
      }
    }

    if (c === "!" && src[i + 1] === "[") {
      const parsed = readBracket(src, i + 1);
      if (parsed) {
        const target = readTarget(src, parsed.end, parsed.raw, defs);
        if (target) {
          const href = safeHref(target.href);
          if (href) {
            push({
              t: "image",
              alt: parsed.raw,
              src: href,
              ...(target.title ? { title: target.title } : {}),
            });
            i = target.end;
            continue;
          }
        }
      }
    }

    if (c === "[") {
      // `[^1]` — a footnote reference, not a link.
      const note = /^\[\^([^\]\s]+)\]/.exec(src.slice(i));
      if (note) {
        push({ t: "noteref", id: note[1] });
        i += note[0].length;
        continue;
      }
      const parsed = readBracket(src, i);
      if (parsed) {
        const target = readTarget(src, parsed.end, parsed.raw, defs);
        if (target) {
          const href = safeHref(target.href);
          if (href) {
            push({
              t: "link",
              parts: parseInline(parsed.raw, defs),
              href,
              ...(target.title ? { title: target.title } : {}),
            });
            i = target.end;
            continue;
          }
        }
      }
    }

    if (c === "<") {
      const br = /^<br\s*\/?>/i.exec(src.slice(i));
      if (br) {
        push({ t: "br" });
        i += br[0].length;
        continue;
      }
      // `<https://…>` — the explicit form. Other schemes (`mailto:`,
      // `file:`) are refused by `safeHref` and stay as literal text: this
      // window has nowhere safe to send them.
      const auto = /^<(https?:\/\/[^>\s]+)>/i.exec(src.slice(i));
      if (auto) {
        const href = safeHref(auto[1]);
        if (href) {
          push({ t: "link", parts: [{ t: "text", v: auto[1] }], href });
          i += auto[0].length;
          continue;
        }
      }
    }

    if (c === "*" || c === "_") {
      const double = src[i + 1] === c;
      const marker = double ? c + c : c;
      // `snake_case` is not emphasis: an underscore between word characters
      // never opens anything.
      const opens =
        c === "*" ||
        !(i > 0 && WORD.test(src[i - 1])) ||
        double;
      if (opens) {
        const close = findClose(src, i + marker.length, marker, c);
        if (close > 0) {
          const inner = src.slice(i + marker.length, close);
          if (inner.trim()) {
            push({
              t: double ? "strong" : "em",
              parts: parseInline(inner, defs),
            });
            i = close + marker.length;
            continue;
          }
        }
      }
    }

    if (c === "~") {
      if (src[i + 1] === "~") {
        const close = src.indexOf("~~", i + 2);
        if (close > 0) {
          push({ t: "strike", parts: parseInline(src.slice(i + 2, close), defs) });
          i = close + 2;
          continue;
        }
      } else {
        const sub = /^~([^\s~]+)~/.exec(src.slice(i));
        if (sub) {
          push({ t: "sub", parts: parseInline(sub[1], defs) });
          i += sub[0].length;
          continue;
        }
      }
    }

    if (c === "=" && src[i + 1] === "=") {
      const close = src.indexOf("==", i + 2);
      if (close > 0) {
        push({ t: "mark", parts: parseInline(src.slice(i + 2, close), defs) });
        i = close + 2;
        continue;
      }
    }

    if (c === "^") {
      const sup = /^\^([^\s^]+)\^/.exec(src.slice(i));
      if (sup) {
        push({ t: "sup", parts: parseInline(sup[1], defs) });
        i += sup[0].length;
        continue;
      }
    }

    // A bare address, the way people actually paste them.
    if ((c === "h" || c === "w" || c === "H" || c === "W") && !WORD.test(src[i - 1] ?? "")) {
      const url = RE_URL.exec(src.slice(i));
      if (url) {
        const href = safeHref(url[0]);
        if (href) {
          push({
            t: "link",
            parts: [{ t: "text", v: url[0] }],
            href: /^www\./i.test(url[0]) ? `https://${url[0]}` : href,
          });
          i += url[0].length;
          continue;
        }
      }
    }

    text += c;
    i++;
  }

  flush();
  return out;
}

/** Content of a `[…]`, balancing nested brackets. `null` when it never closes. */
function readBracket(src: string, at: number): { raw: string; end: number } | null {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return { raw: src.slice(at + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * What comes after `[text]`: an inline `(url "title")`, a reference
 * `[label]`, or nothing — in which case the text itself is the label of a
 * shortcut reference (`[Yard]` with a `[yard]: …` somewhere).
 */
function readTarget(
  src: string,
  at: number,
  label: string,
  defs: LinkDefs,
): { href: string; title?: string; end: number } | null {
  if (src[at] === "(") {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          const body = src.slice(at + 1, i).trim();
          const m = /^<?([^\s>]*)>?(?:\s+["'(](.*)["')])?$/.exec(body);
          if (!m) return null;
          return {
            href: m[1],
            ...(m[2] ? { title: m[2] } : {}),
            end: i + 1,
          };
        }
      }
    }
    return null;
  }

  if (src[at] === "[") {
    const ref = readBracket(src, at);
    if (ref) {
      const key = (ref.raw.trim() || label).toLowerCase();
      const def = defs[key];
      if (def) return { ...def, end: ref.end };
      return null;
    }
  }

  const def = defs[label.trim().toLowerCase()];
  if (def) return { ...def, end: at };
  return null;
}

/**
 * The closing delimiter of an emphasis run.
 *
 * Skips code spans (a `*` inside backticks closes nothing) and, for the
 * single-character form, any position that is really half of a double marker.
 */
function findClose(src: string, from: number, marker: string, char: string): number {
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(run, i + run.length);
      if (close > 0) {
        i = close + run.length - 1;
        continue;
      }
    }
    if (c !== char) continue;
    if (marker.length === 2) {
      if (src[i + 1] === char) return i;
      continue;
    }
    if (src[i + 1] === char) {
      i++;
      continue;
    }
    // Emphasis never closes on whitespace, and `_` never closes inside a word.
    if (/\s/.test(src[i - 1] ?? "")) continue;
    if (char === "_" && WORD.test(src[i + 1] ?? "")) continue;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// what the chrome around the preview needs
// ---------------------------------------------------------------------------

/** Inline tree back to bare text — outline labels, `alt`, the tab's title. */
export function plain(parts: Inline[]): string {
  return parts
    .map((p) => {
      switch (p.t) {
        case "text":
        case "code":
          return p.v;
        case "image":
          return p.alt;
        case "br":
          return " ";
        case "noteref":
          return "";
        default:
          return plain(p.parts);
      }
    })
    .join("");
}

export interface OutlineEntry {
  level: number;
  text: string;
  slug: string;
  line: number;
}

/** The document's headings, in reading order — the panel on the right. */
export function outline(blocks: Block[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === "h") {
        out.push({ level: b.level, text: plain(b.parts), slug: b.slug, line: b.line });
      } else if (b.t === "quote" || b.t === "note") {
        walk(b.blocks);
      } else if (b.t === "list") {
        for (const item of b.items) walk(item.blocks);
      }
    }
  };
  walk(blocks);
  return out;
}

export interface DocStats {
  words: number;
  chars: number;
  /** Minutes at 200 words per minute, rounded up; `0` for an empty file. */
  minutes: number;
  tasks: { done: number; total: number };
}

/**
 * Counts for the status bar.
 *
 * Fenced code does not count as prose — a file with a 400-line snippet is not
 * a 40-minute read — and neither do the markers themselves.
 */
export function stats(src: string): DocStats {
  let prose = "";
  let fence: string | null = null;
  let done = 0;
  let total = 0;
  for (const line of src.split("\n")) {
    const f = RE_FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    // The markers themselves are not prose: a checked task is one word
    // ("feito"), not three ("-", "[x]", "feito").
    let body = line.replace(/^ {0,3}(#{1,6}|>)[ \t]*/, "");
    const item = RE_ITEM.exec(body);
    if (item) {
      body = body.slice(item[0].length);
      const task = RE_TASK.exec(body);
      if (task) {
        total++;
        if (task[1] !== " ") done++;
        body = body.slice(task[0].length);
      }
    }
    prose += `${body}\n`;
  }
  const stripped = prose
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/[#>*_~=|[\]-]/g, " ");
  const words = stripped.split(/\s+/).filter(Boolean).length;
  return {
    words,
    chars: src.length,
    minutes: words ? Math.max(1, Math.round(words / 200)) : 0,
    tasks: { done, total },
  };
}
