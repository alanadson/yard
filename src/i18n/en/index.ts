/**
 * The English dictionary: PT-BR sentence → English sentence, one file per
 * area of the interface so that eight people can write lines at once
 * without touching the same file. This index is the only place that knows
 * the list; `lib/i18n.ts` reads the merged result.
 *
 * Rules, checked by `index.test.ts`: a line never equals its key (a sentence
 * that reads the same in both languages is simply left out — the fallback
 * returns the key), never empty, and the same key means the same line in
 * every area.
 */
import bench from "./bench";
import canvas from "./canvas";
import editor from "./editor";
import lib from "./lib";
import modals from "./modals";
import notes from "./notes";
import settings from "./settings";
import shell from "./shell";
import stores from "./stores";

export const AREAS = {
  shell,
  canvas,
  modals,
  settings,
  bench,
  editor,
  notes,
  lib,
  stores,
} as const;

const EN: Readonly<Record<string, string>> = Object.freeze(
  Object.assign({}, ...Object.values(AREAS)) as Record<string, string>,
);

export default EN;
