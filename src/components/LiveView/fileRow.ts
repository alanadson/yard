/**
 * What a "touched file" row does, and what it says.
 *
 * Rule extracted from the JSX because it decides accessibility: while it was
 * an inline `disabled={!isRepo}`, the whole list left the tab order in a
 * project without git and the reason showed up nowhere. See `fileRow.test.ts`.
 */

/** The reason, written once: serves the tooltip and the warning on click. */
export const NO_REPO = "Sem diff: esta pasta não é um repositório git.";

export interface FileRow {
  /** `abre-diff` leads to the viewer; `explica` warns why it cannot. */
  readonly action: "abre-diff" | "explica";
  readonly tip: string;
}

export function fileRow(path: string, eRepo: boolean): FileRow {
  return eRepo
    ? { action: "abre-diff", tip: `${path}\nAbrir o diff` }
    : { action: "explica", tip: `${path}\n${NO_REPO}` };
}
