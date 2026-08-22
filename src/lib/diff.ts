/**
 * Unified diff parser (`git diff` output) for the viewer.
 *
 * Raw text becomes a structure with line numbers on both sides, del/add
 * pairing (for the side-by-side view) and intraline highlight of the
 * span that actually changed. All pure — no UI dependency.
 */

export type DiffLineType = "add" | "del" | "ctx" | "note";

export interface DiffLine {
  type: DiffLineType;
  /** Content without the +/-/space prefix. */
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** Span that actually differs on the line, [start, end) — pairs only. */
  emph?: [number, number] | null;
}

export interface DiffHunk {
  /** The full `@@ ... @@` line, as git wrote it. */
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** Header before the first hunk (diff --git, index, rename...). */
  meta: string[];
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * CSS class of a raw diff line, classified by prefix.
 *
 * The full parse above is what the large viewer uses; this is the cheap path
 * for the inline expand and the hover peek, where the diff is dumped into a
 * `<pre>` and only needs colour. It lives here so both readings of a diff
 * agree on what counts as metadata.
 */
export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-hunk";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ")
  )
    return "diff-meta";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const meta: string[] = [];
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = text.split("\n");
  // `git diff` ends with \n: the split leaves a trailing "" that is not a line.
  if (lines[lines.length - 1] === "") lines.pop();

  for (const raw of lines) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (!cur) {
      meta.push(raw);
      continue;
    }
    if (raw.startsWith("+")) {
      cur.lines.push({ type: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      cur.lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
      cur.lines.push({ type: "note", text: raw, oldNo: null, newNo: null });
    } else {
      // Context (prefix " "; a fully empty line is also context).
      cur.lines.push({
        type: "ctx",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }

  return { meta, hunks };
}

/**
 * One row of the side-by-side view. `left`/`right` point to the SAME
 * `DiffLine` instances from the parse — annotating `emph` on them applies
 * to both views.
 */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Pairs a hunk for the side-by-side view: context occupies both columns;
 * a run of deletions followed by a run of additions becomes line-by-line
 * pairs (the remainder gets one side empty).
 */
export function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const L = hunk.lines;
  let i = 0;
  while (i < L.length) {
    const ln = L[i];
    if (ln.type === "ctx" || ln.type === "note") {
      rows.push({ left: ln, right: ln });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < L.length && L[i].type === "del") dels.push(L[i++]);
    while (i < L.length && L[i].type === "add") adds.push(L[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
    if (n === 0) i++; // should never happen; avoids an infinite loop
  }
  return rows;
}

/**
 * Annotates the intraline highlight on del/add pairs of every hunk.
 *
 * Cheap and effective heuristic: the common prefix and suffix bound the
 * middle that changed. If the line changed almost entirely, no highlight —
 * painting everything does not help reading.
 */
export function annotateIntraline(parsed: ParsedDiff): void {
  for (const hunk of parsed.hunks) {
    for (const row of toSplitRows(hunk)) {
      const a = row.left;
      const b = row.right;
      if (!a || !b || a === b || a.type !== "del" || b.type !== "add") continue;
      const [ea, eb] = commonEmph(a.text, b.text);
      a.emph = ea;
      b.emph = eb;
    }
  }
}

/**
 * The one span where two strings differ — common head and tail trimmed off.
 *
 * Three places want exactly this, always for the same reason: to write the
 * *smallest* edit instead of the whole text. The viewer paints it; the canvas
 * note replays it through `execCommand` so Ctrl+Z keeps working; the markdown
 * bar dispatches it to CodeMirror so pressing "bold" undoes like typing.
 * Replacing everything would be correct and would throw all three away.
 */
export function changedSpan(
  a: string,
  b: string,
): { from: number; to: number; insert: string } {
  const max = Math.min(a.length, b.length);
  let head = 0;
  while (head < max && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { from: head, to: a.length - tail, insert: b.slice(head, b.length - tail) };
}

function commonEmph(
  a: string,
  b: string,
): [[number, number] | null, [number, number] | null] {
  if (a === b) return [null, null];
  const { from, to, insert } = changedSpan(a, b);
  const ra: [number, number] = [from, to];
  const rb: [number, number] = [from, from + insert.length];
  const fracA = (ra[1] - ra[0]) / Math.max(1, a.length);
  const fracB = (rb[1] - rb[0]) / Math.max(1, b.length);
  if (fracA > 0.9 && fracB > 0.9) return [null, null];
  return [ra[0] < ra[1] ? ra : null, rb[0] < rb[1] ? rb : null];
}
