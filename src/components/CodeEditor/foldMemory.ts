/**
 * Folds that outlive the window: the half that talks to a live editor.
 *
 * What gets written, what is accepted back from disk and which folds still
 * fit a document that changed live in `foldRecord.ts`, which carries no
 * CodeMirror so `editorStore` can use it from the boot path. This module
 * only reads the folds out of an editor state and turns a record back into
 * fold effects, so it loads with the editor. The record's API is re-exported
 * here: code that already holds CodeMirror has one place to import folds from.
 */
import { foldEffect, foldedRanges } from "@codemirror/language";
import type { EditorState, StateEffect } from "@codemirror/state";

import { validFolds, type FoldRange } from "./foldRecord";

export {
  MAX_FOLDS,
  parseFoldRecord,
  parseFolds,
  serializeFoldRecord,
  serializeFolds,
  validFolds,
  type FoldRange,
  type FoldRecord,
} from "./foldRecord";

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
