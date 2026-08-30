/**
 * Folds that outlive the window.
 *
 * A fold is the reader saying "not this part, not today", and it used to last
 * exactly as long as the process did. Keeping it means writing offsets into
 * the record the open tabs already live in, and an offset is a promise about
 * a file that an agent, a rebase or a formatter may have rewritten while the
 * app was closed.
 *
 * Hence the shape of everything below: what comes back from disk is treated
 * as *input*, never as data we wrote. A fold that no longer fits the document
 * in front of us is dropped without ceremony, because a fold restored onto
 * the wrong range hides code nobody asked to hide, and that is worse than
 * forgetting it.
 */
import { foldEffect, foldedRanges } from "@codemirror/language";
import type { EditorState, StateEffect } from "@codemirror/state";

export interface FoldRange {
  from: number;
  to: number;
}

/** Past this, restoring costs more than the folds are worth. */
export const MAX_FOLDS = 200;

/** The folds this document can actually hold, in order. */
export function validFolds(
  folds: readonly FoldRange[],
  docLength: number,
): FoldRange[] {
  return folds
    .filter((f) => f.from >= 0 && f.to > f.from && f.to <= docLength)
    .sort((a, b) => a.from - b.from)
    .slice(0, MAX_FOLDS);
}

/** `from-to,from-to`, small, and readable in a kv dump. */
export function serializeFolds(folds: readonly FoldRange[]): string {
  return folds.map((f) => `${f.from}-${f.to}`).join(",");
}

/** The other half. Anything unreadable is skipped, never thrown. */
export function parseFolds(text: string): FoldRange[] {
  if (!text) return [];
  const folds: FoldRange[] = [];
  for (const piece of text.split(",")) {
    const match = /^(\d+)-(\d+)$/.exec(piece.trim());
    if (!match) continue;
    folds.push({ from: Number(match[1]), to: Number(match[2]) });
  }
  return folds;
}

/** What is folded in a live editor state. */
export function foldsOf(state: EditorState): FoldRange[] {
  const folds: FoldRange[] = [];
  const ranges = foldedRanges(state);
  ranges.between(0, state.doc.length, (from, to) => {
    folds.push({ from, to });
  });
  return folds;
}

/** The effects that put `folds` back, skipping whatever no longer fits. */
export function foldEffectsFor(
  folds: readonly FoldRange[],
  docLength: number,
): StateEffect<FoldRange>[] {
  return validFolds(folds, docLength).map((f) => foldEffect.of(f));
}

/** Folds per document id, what the kv holds for the whole workspace. */
export type FoldRecord = Record<string, FoldRange[]>;

/** Files with nothing folded do not earn an entry. */
export function serializeFoldRecord(record: FoldRecord): string {
  const out: Record<string, string> = {};
  for (const [id, folds] of Object.entries(record)) {
    if (folds.length) out[id] = serializeFolds(folds);
  }
  if (Object.keys(out).length === 0) return "";
  return JSON.stringify(out);
}

/** The other half, hardened the same way `parseFolds` is. */
export function parseFoldRecord(raw: string | undefined): FoldRecord {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: FoldRecord = {};
  for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const folds = parseFolds(value);
    if (folds.length) out[id] = folds;
  }
  return out;
}
