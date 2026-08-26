/**
 * The commands behind the note's formatting bar.
 *
 * Everything here is pure text: a value plus a selection goes in, a value plus
 * a selection comes out. The note stays a plain `<textarea>` — what you see is
 * exactly what agents read through the CLI — and this file is the only place
 * that knows what `**` or `- [ ]` mean while you are typing.
 *
 * Keeping it separate from React is what makes it testable: every rule below
 * (toggling off a marker you already have, keeping the caret where the eye
 * left it, continuing a list on Enter) is the kind of thing that only breaks
 * at the third edge case.
 */
import { t } from "./i18n";

export type MdCommand =
  // block
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "paragraph"
  | "bullet"
  | "ordered"
  | "task"
  | "quote"
  // inline
  | "bold"
  | "italic"
  | "strike"
  | "highlight"
  | "code"
  | "link"
  | "image"
  // whole lines
  | "codeblock"
  | "rule"
  | "table"
  | "footnote"
  | "indent"
  | "outdent"
  | "toggleTask"
  | "duplicate"
  | "moveUp"
  | "moveDown"
  | "clear";

export interface MdSel {
  value: string;
  start: number;
  end: number;
}

/** How much one Tab (or one nesting level) is worth. */
const UNIT = "  ";

// --- line geometry ---

function lineStart(v: string, pos: number): number {
  if (pos <= 0) return 0;
  return v.lastIndexOf("\n", pos - 1) + 1;
}

function lineEnd(v: string, pos: number): number {
  const i = v.indexOf("\n", pos);
  return i === -1 ? v.length : i;
}

/**
 * The whole lines the selection touches.
 *
 * A selection that ends exactly on a line break stops at the previous line:
 * dragging down to the start of the next paragraph should not turn *it* into
 * a heading too.
 */
function blockSpan(s: MdSel): { from: number; to: number } {
  const tail =
    s.end > s.start && s.value[s.end - 1] === "\n" ? s.end - 1 : s.end;
  return { from: lineStart(s.value, s.start), to: lineEnd(s.value, tail) };
}

/**
 * Rewrites a run of lines and carries the selection with it.
 *
 * The caret keeps its column *relative to the change in front of it* — every
 * command here edits the start of a line, so a caret in the middle of the
 * word simply travels by the same amount the prefix did instead of jumping
 * to the end of the line.
 */
function rewrite(s: MdSel, from: number, to: number, out: string[]): MdSel {
  const lines = s.value.slice(from, to).split("\n");
  const after = out.join("\n");
  const total = after.length - (to - from);
  const remap = (pos: number): number => {
    if (pos <= from) return pos;
    if (pos >= to) return pos + total;
    let inAt = from;
    let outAt = from;
    for (let i = 0; i < lines.length; i++) {
      const inEnd = inAt + lines[i].length;
      if (pos <= inEnd) {
        const col = pos - inAt + (out[i].length - lines[i].length);
        return outAt + Math.min(Math.max(col, 0), out[i].length);
      }
      inAt = inEnd + 1;
      outAt += out[i].length + 1;
    }
    return pos + total;
  };
  return {
    value: s.value.slice(0, from) + after + s.value.slice(to),
    start: remap(s.start),
    end: remap(s.end),
  };
}

// --- block markers ---

/** Indent, block marker (if any) and what is left of the line. */
const PREFIX_RE =
  /^([ \t]*)(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+\[[ xX]\][ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)?/;

interface Parts {
  indent: string;
  marker: string;
  body: string;
}

export function splitLine(line: string): Parts {
  const m = PREFIX_RE.exec(line);
  if (!m) return { indent: "", marker: "", body: line };
  return { indent: m[1], marker: m[2] ?? "", body: line.slice(m[0].length) };
}

export type BlockKind =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "bullet"
  | "ordered"
  | "task"
  | "quote"
  | "paragraph";

const MARKER: Record<BlockKind, (i: number) => string> = {
  h1: () => "# ",
  h2: () => "## ",
  h3: () => "### ",
  h4: () => "#### ",
  h5: () => "##### ",
  h6: () => "###### ",
  bullet: () => "- ",
  ordered: (i) => `${i + 1}. `,
  task: () => "- [ ] ",
  quote: () => "> ",
  paragraph: () => "",
};

const IS: Record<BlockKind, (marker: string) => boolean> = {
  h1: (m) => /^#[ \t]/.test(m),
  h2: (m) => /^##[ \t]/.test(m),
  h3: (m) => /^###[ \t]/.test(m),
  h4: (m) => /^####[ \t]/.test(m),
  h5: (m) => /^#####[ \t]/.test(m),
  h6: (m) => /^######[ \t]/.test(m),
  bullet: (m) => /^[-*+][ \t]+$/.test(m),
  ordered: (m) => /^\d+[.)][ \t]+$/.test(m),
  task: (m) => /^[-*+][ \t]+\[[ xX]\]/.test(m),
  quote: (m) => /^>/.test(m),
  paragraph: (m) => m === "",
};

/**
 * Puts one block marker on every touched line — or takes it off.
 *
 * Pressing "heading 2" on something that already *is* a heading 2 turns it
 * back into a paragraph. That is the whole reason these are buttons with a
 * pressed state and not a menu of one-way conversions.
 */
function setBlock(s: MdSel, kind: BlockKind): MdSel {
  const { from, to } = blockSpan(s);
  const lines = s.value.slice(from, to).split("\n");
  const already = kind !== "paragraph" && lines.every((l) => IS[kind](splitLine(l).marker));
  const target: BlockKind = already ? "paragraph" : kind;
  const out = lines.map((l, i) => {
    const { indent, body } = splitLine(l);
    return indent + MARKER[target](i) + body;
  });
  return rewrite(s, from, to, out);
}

/** Which block marker a line is already wearing — what the bar shows pressed. */
export function blockOf(value: string, pos: number): BlockKind {
  const { marker } = splitLine(value.slice(lineStart(value, pos), lineEnd(value, pos)));
  const order: BlockKind[] = [
    "h6",
    "h5",
    "h4",
    "h3",
    "h2",
    "h1",
    "task",
    "bullet",
    "ordered",
    "quote",
  ];
  return order.find((k) => IS[k](marker)) ?? "paragraph";
}

// --- inline markers ---

const WORD_RE = /[\p{L}\p{N}_-]/u;

/** The word the caret is sitting in, so Ctrl+B with no selection still works. */
function wordAt(v: string, pos: number): [number, number] {
  let a = pos;
  let b = pos;
  while (a > 0 && WORD_RE.test(v[a - 1])) a--;
  while (b < v.length && WORD_RE.test(v[b])) b++;
  return [a, b];
}

/**
 * Wraps the selection in a marker pair, or unwraps it if it is already there.
 *
 * Three cases, in the order a hand meets them: the markers are inside the
 * selection (you selected `**bold**`), they are just outside it (you selected
 * `bold` between the stars), or there is nothing selected at all — then the
 * word under the caret is taken, and an empty caret gets the pair with the
 * cursor parked between the halves.
 */
function wrap(s: MdSel, open: string, close = open): MdSel {
  let { start, end } = s;
  const v = s.value;
  if (start === end) {
    const [a, b] = wordAt(v, start);
    if (b > a) {
      start = a;
      end = b;
    } else {
      const value = v.slice(0, start) + open + close + v.slice(start);
      const at = start + open.length;
      return { value, start: at, end: at };
    }
  }
  const sel = v.slice(start, end);
  if (
    sel.length >= open.length + close.length &&
    sel.startsWith(open) &&
    sel.endsWith(close)
  ) {
    const inner = sel.slice(open.length, sel.length - close.length);
    return {
      value: v.slice(0, start) + inner + v.slice(end),
      start,
      end: start + inner.length,
    };
  }
  if (
    v.slice(start - open.length, start) === open &&
    v.slice(end, end + close.length) === close
  ) {
    return {
      value: v.slice(0, start - open.length) + sel + v.slice(end + close.length),
      start: start - open.length,
      end: end - open.length,
    };
  }
  return {
    value: v.slice(0, start) + open + sel + close + v.slice(end),
    start: start + open.length,
    end: end + open.length,
  };
}

/**
 * `[texto](url)`, with the caret parked in whichever half is still missing.
 *
 * Selecting something that already looks like an address flips the halves:
 * the URL is the part you had, so the caret lands where the label goes.
 */
function link(s: MdSel): MdSel {
  const sel = s.value.slice(s.start, s.end);
  const isUrl = /^(https?:\/\/|www\.)\S+$/i.test(sel.trim());
  const text = isUrl ? "" : sel;
  const href = isUrl ? sel.trim() : "";
  const out = `[${text}](${href})`;
  const at = isUrl ? s.start + 1 : s.start + out.length - 1;
  return {
    value: s.value.slice(0, s.start) + out + s.value.slice(s.end),
    start: at,
    end: at,
  };
}

/**
 * `![alt](caminho)`. Same flip as the link: what you had selected decides
 * which half is already filled, and the caret lands on the other one.
 */
function image(s: MdSel): MdSel {
  const sel = s.value.slice(s.start, s.end);
  const looksLikeSrc =
    /^(https?:\/\/|\.{0,2}\/)?\S+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(sel.trim());
  const alt = looksLikeSrc ? "" : sel;
  const src = looksLikeSrc ? sel.trim() : "";
  const out = `![${alt}](${src})`;
  const at = looksLikeSrc ? s.start + 2 : s.start + out.length - 1;
  return {
    value: s.value.slice(0, s.start) + out + s.value.slice(s.end),
    start: at,
    end: at,
  };
}

// --- whole-line commands ---

function lineIndex(v: string, pos: number): number {
  let n = 0;
  for (let i = 0; i < pos; i++) if (v[i] === "\n") n++;
  return n;
}

/**
 * The fence pair the given lines sit inside, if any.
 *
 * Counted from the top of the note, never by looking upward from the caret:
 * the line right *after* a closing fence would find that fence above it and
 * read as "inside", and pressing the button there would rip out a block the
 * caret is not even in.
 */
function fenceAround(lines: string[], a: number, b: number): [number, number] | null {
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```/.test(lines[i])) continue;
    if (open === -1) {
      open = i;
      continue;
    }
    if (a >= open && b <= i) return [open, i]; // i18n-ok — not a sentence
    open = -1;
  }
  return null;
}

/** Fences the touched lines — or takes the fence off if they already have one. */
function codeBlock(s: MdSel): MdSel {
  const { from, to } = blockSpan(s);
  const lines = s.value.split("\n");
  const fence = fenceAround(lines, lineIndex(s.value, from), lineIndex(s.value, to));
  if (fence) {
    const kept = lines.slice(fence[0] + 1, fence[1]);
    const head = lines.slice(0, fence[0]);
    const at = head.reduce((n, l) => n + l.length + 1, 0);
    return {
      value: [...head, ...kept, ...lines.slice(fence[1] + 1)].join("\n"),
      start: at,
      end: at + kept.join("\n").length,
    };
  }
  const body = s.value.slice(from, to);
  const value = s.value.slice(0, from) + "```\n" + body + "\n```" + s.value.slice(to);
  // Empty selection: the caret goes to the blank line between the fences,
  // which is where a paste lands. With content, the content stays selected.
  return { value, start: from + 4, end: from + 4 + body.length };
}

/** A `---` on its own line, right below the one the caret is on. */
function rule(s: MdSel): MdSel {
  const to = lineEnd(s.value, s.end);
  const cur = s.value.slice(lineStart(s.value, s.end), to);
  const out = `${cur.trim() ? "\n" : ""}---\n`;
  const at = to + out.length;
  return { value: s.value.slice(0, to) + out + s.value.slice(to), start: at, end: at };
}

/**
 * A GFM table with the header already spelled out.
 *
 * Three columns and two body rows: enough to see the shape, few enough to
 * delete what is not wanted. The caret lands on the first header cell, which
 * is the first thing anyone types. Selected text becomes that cell — pressing
 * the button over a word turns the word into the table's first column.
 */
function table(s: MdSel): MdSel {
  const to = lineEnd(s.value, s.end);
  const cur = s.value.slice(lineStart(s.value, s.end), to);
  const col1 = t("Coluna 1");
  const head = (s.value.slice(s.start, s.end).split("\n")[0] || col1).trim();
  const rows = [
    `| ${head} | ${t("Coluna 2")} | ${t("Coluna 3")} |`,
    "| --- | --- | --- |",
    "|  |  |  |",
    "|  |  |  |",
  ];
  const out = `${cur.trim() ? "\n\n" : ""}${rows.join("\n")}\n`;
  // Over the header cell: the selection *is* the text that now titles it.
  const at = to + out.indexOf(head) + (head === col1 ? 0 : head.length);
  return {
    value: s.value.slice(0, to) + out + s.value.slice(to),
    start: at,
    end: head === col1 ? at + head.length : at,
  };
}

/**
 * A footnote: the `[^n]` mark where the caret is, and its definition parked
 * at the end of the document — which is where markdown renders it anyway.
 *
 * The number is the first one nobody is using yet, so writing footnotes out
 * of order (or deleting one) never produces two `[^2]` pointing at each other.
 */
function footnote(s: MdSel): MdSel {
  const used = new Set<number>();
  for (const m of s.value.matchAll(/\[\^(\d+)\]/g)) used.add(Number(m[1]));
  let n = 1;
  while (used.has(n)) n++;

  const mark = `[^${n}]`;
  const withMark = s.value.slice(0, s.end) + mark + s.value.slice(s.end);
  const trailingNewline = withMark.endsWith("\n") ? "" : "\n";
  const blankLine = /\n\[\^\d+\]:[^\n]*\n?$/.test(withMark) ? "" : "\n";
  const def = `${trailingNewline}${blankLine}${mark}: `;
  const at = withMark.length + def.length;
  return { value: withMark + def, start: at, end: at };
}

function shift(s: MdSel, by: 1 | -1): MdSel {
  const { from, to } = blockSpan(s);
  const out = s.value
    .slice(from, to)
    .split("\n")
    .map((l) => {
      if (by === 1) return UNIT + l;
      if (l.startsWith(UNIT)) return l.slice(UNIT.length);
      if (l.startsWith("\t")) return l.slice(1);
      return l.replace(/^[ \t]/, "");
    });
  return rewrite(s, from, to, out);
}

/**
 * `- [ ]` ⇄ `- [x]` on a single line.
 *
 * Exported on its own because the reading view uses it too: the checkbox a
 * note paints is a real checkbox, and clicking it flips the source line
 * without opening the editor.
 */
export function toggleTaskLine(line: string): string {
  const done = /^([ \t]*[-*+][ \t]+)\[([ xX])\](.*)$/.exec(line);
  if (done) return `${done[1]}[${done[2] === " " ? "x" : " "}]${done[3]}`;
  const bullet = /^([ \t]*[-*+][ \t]+)(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}[ ] ${bullet[2]}`;
  const plain = /^([ \t]*)(.*)$/.exec(line);
  return plain ? `${plain[1]}- [ ] ${plain[2]}` : `- [ ] ${line}`;
}

function toggleTask(s: MdSel): MdSel {
  const { from, to } = blockSpan(s);
  const out = s.value.slice(from, to).split("\n").map(toggleTaskLine);
  return rewrite(s, from, to, out);
}

function duplicate(s: MdSel): MdSel {
  const { from, to } = blockSpan(s);
  const body = s.value.slice(from, to);
  const at = to + 1 + (s.start - from);
  return {
    value: `${s.value.slice(0, to)}\n${body}${s.value.slice(to)}`,
    start: at,
    end: at + (s.end - s.start),
  };
}

function move(s: MdSel, by: 1 | -1): MdSel {
  const { from, to } = blockSpan(s);
  const body = s.value.slice(from, to);
  if (by === -1) {
    if (from === 0) return s;
    const prevFrom = lineStart(s.value, from - 1);
    const prev = s.value.slice(prevFrom, from - 1);
    const value = s.value.slice(0, prevFrom) + body + "\n" + prev + s.value.slice(to);
    const d = prevFrom - from;
    return { value, start: s.start + d, end: s.end + d };
  }
  if (to >= s.value.length) return s;
  const nextTo = lineEnd(s.value, to + 1);
  const next = s.value.slice(to + 1, nextTo);
  const value = s.value.slice(0, from) + next + "\n" + body + s.value.slice(nextTo);
  const d = next.length + 1;
  return { value, start: s.start + d, end: s.end + d };
}

/** Everything the note knows how to mark, taken back off. */
function stripInline(t: string): string {
  return t
    // The image before the link: they share the shape, and the link rule
    // alone would leave the `!` behind as loose punctuation.
    .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/==([^=\n]+)==/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1");
}

function clear(s: MdSel): MdSel {
  const { from, to } = blockSpan(s);
  const out = s.value
    .slice(from, to)
    .split("\n")
    .map((l) => {
      const { indent, body } = splitLine(l);
      return indent + stripInline(body);
    });
  return rewrite(s, from, to, out);
}

// --- the one door in ---

export function applyMd(cmd: MdCommand, s: MdSel): MdSel {
  switch (cmd) {
    case "h1":
      return setBlock(s, "h1");
    case "h2":
      return setBlock(s, "h2");
    case "h3":
      return setBlock(s, "h3");
    case "h4":
      return setBlock(s, "h4");
    case "h5":
      return setBlock(s, "h5");
    case "h6":
      return setBlock(s, "h6");
    case "paragraph":
      return setBlock(s, "paragraph");
    case "bullet":
      return setBlock(s, "bullet");
    case "ordered":
      return setBlock(s, "ordered");
    case "task":
      return setBlock(s, "task");
    case "quote":
      return setBlock(s, "quote");
    case "bold":
      return wrap(s, "**");
    case "italic":
      return wrap(s, "*");
    case "strike":
      return wrap(s, "~~");
    case "highlight":
      return wrap(s, "==");
    case "code":
      return wrap(s, "`");
    case "link":
      return link(s);
    case "image":
      return image(s);
    case "codeblock":
      return codeBlock(s);
    case "rule":
      return rule(s);
    case "table":
      return table(s);
    case "footnote":
      return footnote(s);
    case "indent":
      return shift(s, 1);
    case "outdent":
      return shift(s, -1);
    case "toggleTask":
      return toggleTask(s);
    case "duplicate":
      return duplicate(s);
    case "moveUp":
      return move(s, -1);
    case "moveDown":
      return move(s, 1);
    case "clear":
      return clear(s);
  }
}

/**
 * Enter inside a list, a task or a quote.
 *
 * Continues the marker on the next line, and — the part that matters —
 * *removes* it when you press Enter on an item you never filled in. That
 * double-Enter is how everyone leaves a list, and without it the only way out
 * is to backspace over a bullet you did not type.
 *
 * Returns `null` when the line is ordinary: the textarea's own Enter is
 * always better than a re-implementation of it.
 */
export function enterKey(s: MdSel): MdSel | null {
  if (s.start !== s.end) return null;
  const from = lineStart(s.value, s.start);
  const line = s.value.slice(from, s.start);
  const { indent, marker, body } = splitLine(line);
  if (!marker) return null;

  if (!body.trim()) {
    // An empty item: clear the marker instead of making another one.
    const value = s.value.slice(0, from) + indent + s.value.slice(s.start);
    const at = from + indent.length;
    return { value, start: at, end: at };
  }

  const ord = /^(\d+)([.)][ \t]+)$/.exec(marker);
  const next = ord
    ? `${Number(ord[1]) + 1}${ord[2]}`
    : // A finished task continues as an open one — nobody wants the next
      // line pre-checked.
      marker.replace(/\[[xX]\]/, "[ ]");
  const ins = `\n${indent}${next}`;
  const at = s.start + ins.length;
  return {
    value: s.value.slice(0, s.start) + ins + s.value.slice(s.start),
    start: at,
    end: at,
  };
}
