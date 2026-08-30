/**
 * The git calha, made usable.
 *
 * The strip beside the line numbers has always known which lines are born,
 * changed or gone. It could not say *what they were*, or put them back,
 * because `LineChanges` describes only the new side of the file. A `Hunk`
 * carries both sides, which is what a peek, a revert and the two walk keys
 * all need.
 *
 * The revert is the one with teeth: it replaces a range of the buffer with a
 * range of the file as git has it. An off-by-one here does not fail, it
 * quietly eats a line of somebody's work, which is why the bounds are checked
 * against the text in hand rather than trusted.
 */
import type { Hunk } from "./lineDiff";

export type { Hunk } from "./lineDiff";

/**
 * The change at `line` (1-based), or `null`.
 *
 * A pure deletion owns no new line at all, so it is found from the line that
 * took its place: that row is the only place on screen there is to click.
 */
export function hunkAt(hunks: readonly Hunk[], line: number): Hunk | null {
  for (const hunk of hunks) {
    if (hunk.newTo < hunk.newFrom) {
      if (line === hunk.newFrom) return hunk;
      continue;
    }
    if (line >= hunk.newFrom && line <= hunk.newTo) return hunk;
  }
  return null;
}

/**
 * The next change below `line`, wrapping. Strictly below: pressing the key
 * twice has to move twice, and a hunk the caret is already standing in is not
 * somewhere to go.
 */
export function nextHunk(hunks: readonly Hunk[], line: number): Hunk | null {
  if (hunks.length === 0) return null;
  return hunks.find((h) => h.newFrom > line) ?? hunks[0];
}

/** The previous change above `line`, wrapping. */
export function prevHunk(hunks: readonly Hunk[], line: number): Hunk | null {
  if (hunks.length === 0) return null;
  for (let i = hunks.length - 1; i >= 0; i--) {
    if (hunks[i].newFrom < line) return hunks[i];
  }
  return hunks[hunks.length - 1];
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * The smallest single change that turns `before` into `after`, or `null` when
 * they are already the same.
 *
 * `revertHunk` answers with a whole new document, which is the easy shape to
 * get right and the wrong one to hand an editor: replacing the document
 * wholesale costs the reader their caret and folds one undo step around the
 * entire file. Trimming the common head and tail gives back the span that
 * actually moved.
 */
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head++;
  }
  // The tail may not run back past the head, or the span would end before it
  // starts: "aaa" and "aa" share two characters from each end of three.
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    from: head,
    to: before.length - tail,
    insert: after.slice(head, after.length - tail),
  };
}

/**
 * The lines HEAD has for this hunk, for the panel that shows what a line
 * *was*. Empty for a line that is simply new, and empty rather than wrong for
 * a hunk that no longer fits the text in hand.
 */
export function peekLines(headText: string, hunk: Hunk): string[] {
  const head = headText.split(/\r?\n/);
  const from = hunk.oldFrom - 1;
  if (from < 0 || hunk.oldTo > head.length || hunk.oldTo < from) return [];
  return head.slice(from, hunk.oldTo);
}

/**
 * `buffer` with the hunk's lines replaced by the ones HEAD has. `null` when
 * the hunk does not fit either text: the marks are recomputed on a debounce,
 * so a hunk in hand can be a moment out of date, and writing from a stale one
 * is exactly how a revert eats the wrong line.
 *
 * The buffer's own line ending is kept. A revert that normalised them would
 * turn one line into a whole-file diff.
 */
export function revertHunk(buffer: string, headText: string, hunk: Hunk): string | null {
  const eol = buffer.includes("\r\n") ? "\r\n" : "\n";
  const lines = buffer.split(/\r?\n/);
  const head = headText.split(/\r?\n/);

  const newFrom = hunk.newFrom - 1;
  const newTo = hunk.newTo;
  const oldFrom = hunk.oldFrom - 1;
  const oldTo = hunk.oldTo;
  if (newFrom < 0 || newTo > lines.length || newTo < newFrom - 1) return null;
  if (oldFrom < 0 || oldTo > head.length || oldTo < oldFrom - 1) return null;

  const before = lines.slice(0, newFrom);
  const after = lines.slice(Math.max(newFrom, newTo));
  const restored = head.slice(oldFrom, oldTo);
  return [...before, ...restored, ...after].join(eol);
}
