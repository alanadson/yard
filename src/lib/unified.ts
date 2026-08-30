/**
 * A unified diff, built here rather than asked of git.
 *
 * Every comparison the app shows comes from git, which leaves out the one
 * comparison git cannot know about: the draft against what is on disk. "What
 * is Ctrl+S about to write?" is a fair question, and in a window where agents
 * edit the same files it gets asked a lot.
 *
 * The output is a real unified diff because it is handed to the same viewer
 * that renders git's own (`DiffTab`). Two things make it real: the hunk header
 * arithmetic, and merging two changes whose context windows touch. Get either
 * wrong and the result still renders, it just is not true.
 */
import { diffLines, type Hunk } from "./lineDiff";

/** Lines of context around a change, as git's own default. */
const CONTEXT = 3;

interface Block {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
  rows: string[];
}

/**
 * `oldText` against `newText`, as unified diff text. `""` when they match,
 * `null` when the diff gave up (the two texts are too far apart to describe).
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
): string | null {
  if (oldText === newText) return "";
  const changes = diffLines(oldText, newText);
  if (!changes) return null;
  if (changes.hunks.length === 0) return "";

  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  const blocks: Block[] = [];
  for (const hunk of changes.hunks) {
    const block = blockOf(hunk, oldLines, newLines);
    const last = blocks[blocks.length - 1];
    // Touching (or overlapping) context windows have to become one hunk: two
    // headers over overlapping ranges is a diff no tool can apply.
    if (last && block.oldFrom <= last.oldTo + 1 && block.newFrom <= last.newTo + 1) {
      mergeInto(last, block, hunk, oldLines, newLines);
      continue;
    }
    blocks.push(block);
  }

  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const block of blocks) {
    const oldCount = block.oldTo - block.oldFrom + 1;
    const newCount = block.newTo - block.newFrom + 1;
    out.push(`@@ -${block.oldFrom},${oldCount} +${block.newFrom},${newCount} @@`);
    out.push(...block.rows);
  }
  return out.join("\n") + "\n";
}

/** One hunk with its context, as the rows a unified diff prints. */
function blockOf(hunk: Hunk, oldLines: string[], newLines: string[]): Block {
  const leadOld = Math.max(1, hunk.oldFrom - CONTEXT);
  const leadNew = Math.max(1, hunk.newFrom - CONTEXT);
  // The lead is however much context both sides can actually give.
  const lead = Math.min(hunk.oldFrom - leadOld, hunk.newFrom - leadNew);

  const rows: string[] = [];
  for (let i = 0; i < lead; i++) {
    rows.push(" " + newLines[hunk.newFrom - lead + i - 1]);
  }
  for (let n = hunk.oldFrom; n <= hunk.oldTo; n++) rows.push("-" + oldLines[n - 1]);
  for (let n = hunk.newFrom; n <= hunk.newTo; n++) rows.push("+" + newLines[n - 1]);

  const block: Block = {
    oldFrom: hunk.oldFrom - lead,
    oldTo: hunk.oldTo,
    newFrom: hunk.newFrom - lead,
    newTo: hunk.newTo,
    rows,
  };
  // An empty side still starts where its counterpart does; git writes the
  // count as zero and the start as the line before.
  if (block.oldTo < block.oldFrom - 1) block.oldTo = block.oldFrom - 1;
  if (block.newTo < block.newFrom - 1) block.newTo = block.newFrom - 1;
  addTrail(block, oldLines, newLines);
  return block;
}

/** Context after the change, as far as both sides have it. */
function addTrail(block: Block, oldLines: string[], newLines: string[]): void {
  const room = Math.min(oldLines.length - block.oldTo, newLines.length - block.newTo);
  const trail = Math.max(0, Math.min(CONTEXT, room));
  for (let i = 1; i <= trail; i++) block.rows.push(" " + newLines[block.newTo + i - 1]);
  block.oldTo += trail;
  block.newTo += trail;
}

/**
 * Folds a hunk into the block before it: the context they share is written
 * once, as the lines between the two changes.
 */
function mergeInto(
  block: Block,
  next: Block,
  hunk: Hunk,
  oldLines: string[],
  newLines: string[],
): void {
  // Whatever trailing context the block already printed past the gap has to
  // come off before the gap is written once.
  const printedTo = block.newTo;
  const gapStart = Math.min(printedTo, hunk.newFrom - 1);
  const extra = printedTo - gapStart;
  if (extra > 0) {
    block.rows.length -= extra;
    block.newTo -= extra;
    block.oldTo -= extra;
  }
  for (let n = block.newTo + 1; n <= hunk.newFrom - 1; n++) {
    block.rows.push(" " + newLines[n - 1]);
  }
  for (let n = hunk.oldFrom; n <= hunk.oldTo; n++) block.rows.push("-" + oldLines[n - 1]);
  for (let n = hunk.newFrom; n <= hunk.newTo; n++) block.rows.push("+" + newLines[n - 1]);
  block.oldTo = Math.max(block.oldTo, hunk.oldTo);
  block.newTo = Math.max(block.newTo, hunk.newTo);
  // `next` was only built to measure the distance; its trail is the one kept.
  void next;
  addTrail(block, oldLines, newLines);
}
