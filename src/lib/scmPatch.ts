/**
 * Builds the patch that stages (or discards) **one hunk** instead of the whole
 * file. It is what separates "Source Control" from a list of files: the commit
 * becomes what the person meant, not the state the file happened to be in.
 *
 * The path is always the same: the diff already on screen → a new patch →
 * `git apply` (with `--cached` for the index, with `--reverse` to undo). The
 * four combinations of the two flags are stage, unstage, discard and reapply.
 *
 * The arithmetic `git apply` demands:
 *
 * - the **old side** of the patch has to describe the file as it is now, in
 *   full. That is why a `-` line the person did **not** pick does not vanish:
 *   it becomes context, because it still exists there;
 * - the **new side** carries only what is going in. An unpicked `+` line
 *   simply does not appear;
 * - both counts in the `@@` are recounted after that cut. Copying the ones
 *   from the original diff is the classic mistake, and `git apply` answers by
 *   refusing the whole patch without saying where.
 *
 * All pure: text in, text out.
 */

export interface PatchHunk {
  /** Position in the file — it is how the buttons ask for the hunk. */
  index: number;
  /** The `@@ … @@` line as git wrote it. */
  header: string;
  /** The hunk's lines, with the prefix (` `, `+`, `-`, `\`) and without `\n`. */
  lines: string[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  additions: number;
  deletions: number;
}

export interface SplitPatch {
  /** Everything before the first `@@`: `diff --git`, `index`, `---`, `+++`. */
  header: string[];
  hunks: PatchHunk[];
}

/** How many diff lines the expanded row draws before stopping. */
export const SCM_DIFF_LINES = 1_500;

export interface CappedHunks {
  hunks: PatchHunk[];
  /** Lines that exist in the diff and were not drawn. */
  hiddenLines: number;
  /** Whole hunks that never even started being drawn. */
  hiddenHunks: number;
}

/**
 * The cap on drawn lines of a diff.
 *
 * It exists because every line of the hunk becomes a `<span>` with `onClick`,
 * `onKeyDown`, `role` and `tabIndex` — that is how lines get picked one by
 * one — and the backend's 1 MB cut still lets ~20 thousand of them through.
 * Opening a regenerated `package-lock.json` inside the row froze the window.
 *
 * The cut respects the hunk boundary (a partial hunk still draws its `@@`,
 * and its buttons keep asking git for the **whole patch**, by `index`, which
 * the cut preserves). The first hunk always shows: an expanded row that shows
 * nothing is worse than one that shows the beginning.
 */
export function capHunks(hunks: PatchHunk[], max: number): CappedHunks {
  let total = 0;
  for (const h of hunks) total += h.lines.length;
  if (total <= max) return { hunks, hiddenLines: 0, hiddenHunks: 0 };

  const out: PatchHunk[] = [];
  let used = 0;
  for (const h of hunks) {
    const leftover = max - used;
    if (leftover <= 0) break;
    if (h.lines.length <= leftover) {
      out.push(h);
      used += h.lines.length;
      continue;
    }
    // The hunk does not fit whole: it goes in cut, and it is the last one.
    out.push({ ...h, lines: h.lines.slice(0, leftover) });
    used = max;
    break;
  }
  return {
    hunks: out,
    hiddenLines: total - used,
    hiddenHunks: hunks.length - out.length,
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function splitPatch(diff: string): SplitPatch {
  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  let cur: PatchHunk | null = null;

  const lines = diff.split("\n");
  // `git diff` ends in `\n`: the split leaves a trailing "" that is not a line.
  if (lines[lines.length - 1] === "") lines.pop();

  for (const raw of lines) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      cur = {
        index: hunks.length,
        header: raw,
        lines: [],
        oldStart: Number(m[1]),
        // With no comma git is saying "a single line".
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        additions: 0,
        deletions: 0,
      };
      hunks.push(cur);
      continue;
    }
    if (!cur) {
      header.push(raw);
      continue;
    }
    cur.lines.push(raw);
    if (raw.startsWith("+")) cur.additions++;
    else if (raw.startsWith("-")) cur.deletions++;
  }

  return { header, hunks };
}

/**
 * The patch with the chosen whole hunks — copied word for word, which is the
 * case where no count needs redoing.
 */
export function patchForHunks(diff: string, indices: readonly number[]): string {
  const { header, hunks } = splitPatch(diff);
  // In file order, not click order: `git apply` walks the file only once,
  // top to bottom.
  const chosen = [...new Set(indices)]
    .sort((a, b) => a - b)
    .map((i) => hunks[i])
    .filter((h): h is PatchHunk => !!h);
  if (chosen.length === 0) return "";

  const out = [...header];
  for (const h of chosen) {
    out.push(h.header, ...h.lines);
  }
  return `${out.join("\n")}\n`;
}

/**
 * The patch with **some lines** of a hunk. `selected` holds the indices
 * (within `hunk.lines`) of the chosen `+`/`-` lines; context and markers do
 * not need choosing — they go in regardless.
 */
export function patchForLines(
  diff: string,
  hunkIndex: number,
  selected: ReadonlySet<number>,
): string {
  const { header, hunks } = splitPatch(diff);
  const hunk = hunks[hunkIndex];
  if (!hunk) return "";

  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let changed = false;

  for (let i = 0; i < hunk.lines.length; i++) {
    const raw = hunk.lines[i];
    // The "no newline at end" marker describes the line above it: it follows
    // that line's fate, and on its own it means nothing.
    if (raw.startsWith("\\")) {
      if (body.length > 0) body.push(raw);
      continue;
    }
    if (raw.startsWith("+")) {
      if (!selected.has(i)) {
        // Not chosen: does not go in. Nor does the marker right below it.
        if (hunk.lines[i + 1]?.startsWith("\\")) i++;
        continue;
      }
      body.push(raw);
      newCount++;
      changed = true;
      continue;
    }
    if (raw.startsWith("-")) {
      if (!selected.has(i)) {
        // Not chosen: it still exists in the file, so it is context.
        body.push(` ${raw.slice(1)}`);
        oldCount++;
        newCount++;
        continue;
      }
      body.push(raw);
      oldCount++;
      changed = true;
      continue;
    }
    // Context (the prefix is a space; an empty line is context too).
    body.push(raw.startsWith(" ") ? raw : ` ${raw}`);
    oldCount++;
    newCount++;
  }

  // Context only = nothing to apply. Such a patch is accepted by git and does
  // nothing, which is worse than refusing: the button blinks and nothing changes.
  if (!changed) return "";

  // The new side starts where the old one starts: this patch is applied *on
  // top of* the old side, and the original diff's offset was for the whole file.
  const hunkHeader = `@@ -${hunk.oldStart},${oldCount} +${hunk.oldStart},${newCount} @@`;
  return `${[...header, hunkHeader, ...body].join("\n")}\n`;
}
