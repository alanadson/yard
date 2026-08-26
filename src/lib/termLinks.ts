/**
 * What in a line of terminal output is a link.
 *
 * xterm hands over one buffer row at a time; this module answers with the
 * spans that are worth underlining — web addresses and file paths, with the
 * `:line:col` the compilers and the agents attach to them. Pure on purpose:
 * the terminal only draws what this says, and the decision of *where* a match
 * opens lives in `termLinkOpen.ts`.
 *
 * Conservative by design. Every rule here errs toward saying nothing: a false
 * positive is an underline over prose, and a Ctrl+click that opens the wrong
 * file teaches the user to stop trusting the underline.
 */

export type LinkKind = "url" | "path";

export interface LinkMatch {
  /** Offset of the first character, in the row's string. */
  start: number;
  /** Offset past the last character. */
  end: number;
  /** The exact text the underline covers. */
  text: string;
  kind: LinkKind;
  /** Ready to open — with the scheme the output left out (`localhost:5173`). */
  url?: string;
  /** The path as printed, without the `:line:col` suffix. */
  path?: string;
  line?: number;
  col?: number;
}

/**
 * `http(s)://…` as printed, plus the two forms dev servers announce without a
 * scheme: `localhost:5173/…` and `127.0.0.1:3000`. A bare `localhost` in
 * prose is not an address; it needs a port or a path after it.
 */
const URL = /https?:\/\/[^\s<>"'`]+|(?<![\w.-])(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5}(?:\/[^\s<>"'`]*)?|\/[^\s<>"'`]*)/gi;

/**
 * Sentence punctuation glued to the end of what was printed. A `)` only goes
 * when the text has no `(` of its own — `https://en.wikipedia.org/wiki/X_(Y)`
 * keeps its parenthesis.
 */
function trimTrailing(text: string): string {
  let out = text;
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) return out;
    if (last === ")" && out.includes("(")) return out;
    if (!",.;:'\")]>".includes(last)) return out;
    out = out.slice(0, -1);
  }
}

function urlMatches(text: string): LinkMatch[] {
  const out: LinkMatch[] = [];
  for (const m of text.matchAll(URL)) {
    const raw = trimTrailing(m[0]);
    if (!raw) continue;
    const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    out.push({ start: m.index, end: m.index + raw.length, text: raw, kind: "url", url });
  }
  return out;
}

/**
 * One path segment: anything but whitespace, the two separators, `:` (which
 * only appears in a drive letter and in the line suffix) and the punctuation
 * that wraps a path in prose — quotes, brackets, braces, `,` and `;`.
 */
const SEG = "[^\\s\\\\/:*?\"'`<>|()\\[\\]{},;]";

/**
 * A path candidate, with the optional line/column the compilers and agents
 * print after it: `src/x.ts:12:3`, `src/x.ts(12,3)`, `src/x.ts(12)`.
 *
 * The look-behind keeps `b.com` out of `a@b.com` and `x.ts` out of `foo.x.ts`
 * (the whole token is the candidate, not its tail). The look-ahead after the
 * suffix refuses `:42` when more digits or a `:` follow (`12:30:45` is a
 * clock) but lets a sentence end right after it (`src/x.ts:12.`).
 */
const PATH = new RegExp(
  `(?<![\\w@.\\\\/:-])` +
    `((?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?${SEG}+(?:[\\\\/]${SEG}*)*)` +
    `(?::(\\d+)(?::(\\d+))?(?![\\w:]|\\.\\w)|\\((\\d+)(?:,(\\d+))?\\))?`,
  "g",
);

/** Top-level domains that end a bare site name in prose (`github.com`). */
const TLDS = new Set(["com", "org", "net", "io", "dev", "app", "ai", "co", "br", "edu", "gov", "me"]);

/** Extension of the last segment: `ts` in `src/x.ts`, `` in `Makefile`. */
function extensionOf(last: string): string {
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1) : "";
}

/**
 * Is this candidate a path or just a word?
 *
 * A prefix (`./`, `../`, `/`, `C:\`) settles it. Without one, `and/or` and
 * `src/lib` are prose or a folder, so a relative path needs either two
 * separators or a file extension on its last segment. A token with no
 * separator at all only counts as a file (`README.md`, `package.json`) when
 * it has a real extension: letters first, and enough of stem and extension
 * that `e.g` and `i.e` stay words.
 */
function looksLikePath(candidate: string): boolean {
  if (/^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])/.test(candidate)) return true;
  const parts = candidate.split(/[\\/]/);
  const last = parts[parts.length - 1];
  if (!last) return false;
  const ext = extensionOf(last);
  if (parts.length >= 3) return true;
  if (parts.length === 2) return ext.length > 0;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(ext)) return false;
  // `dev@example.com` is an e-mail and `github.com` a site: neither is a file.
  if (last.includes("@") || TLDS.has(ext.toLowerCase())) return false;
  const stem = last.slice(0, last.length - ext.length - 1);
  return stem.length >= 2 && ext.length >= 2;
}

function pathMatches(text: string, taken: readonly LinkMatch[]): LinkMatch[] {
  const out: LinkMatch[] = [];
  for (const m of text.matchAll(PATH)) {
    const start = m.index;
    if (taken.some((t) => start < t.end && start + m[0].length > t.start)) continue;
    const candidate = trimTrailing(m[1]);
    if (!candidate || /[\\/]$/.test(candidate) || !looksLikePath(candidate)) continue;
    // A trimmed candidate lost its suffix's anchor: `src/x.ts.` keeps the
    // path and drops the dot, and the suffix only counts when it followed
    // the untrimmed text directly.
    const trimmed = candidate.length < m[1].length;
    const line = trimmed ? undefined : (m[2] ?? m[4]);
    const col = trimmed ? undefined : (m[3] ?? m[5]);
    const end = start + candidate.length + (trimmed ? 0 : m[0].length - m[1].length);
    const match: LinkMatch = {
      start,
      end,
      text: text.slice(start, end),
      kind: "path",
      path: candidate,
    };
    if (line !== undefined) match.line = Number(line);
    if (col !== undefined) match.col = Number(col);
    out.push(match);
  }
  return out;
}

/** Every link on one row of output, left to right, never overlapping. */
export function findLinks(lineText: string): LinkMatch[] {
  const urls = urlMatches(lineText);
  const paths = pathMatches(lineText, urls);
  return [...urls, ...paths].sort((a, b) => a.start - b.start);
}

/**
 * The span as xterm addresses it: cells are 1-based and the range is
 * inclusive on both ends, so a half-open `[start, end)` string span becomes
 * `[start + 1, end]`. One row only — a link wrapped over two buffer rows is
 * handed to the provider as two rows and matched (or not) on each.
 */
export function linkRange(
  match: Pick<LinkMatch, "start" | "end">,
  row: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  return { start: { x: match.start + 1, y: row }, end: { x: match.end, y: row } };
}
