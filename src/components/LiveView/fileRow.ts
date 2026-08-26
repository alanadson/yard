/**
 * What a "touched file" row does, and what it says.
 *
 * Rule extracted from the JSX because it decides accessibility: while it was
 * an inline `disabled={!isRepo}`, the whole list left the tab order in a
 * project without git and the reason showed up nowhere. See `fileRow.test.ts`.
 */

// i18n-scan: tables
import { t } from "../../lib/i18n";

/** The reason, written once: serves the tooltip and the warning on click. Render it through `t()`. */
export const NO_REPO = "Sem diff: esta pasta não é um repositório git.";

export interface FileRow {
  /** `abre-diff` leads to the viewer; `explica` warns why it cannot. */
  readonly action: "abre-diff" | "explica";
  readonly tip: string;
}

export function fileRow(path: string, eRepo: boolean): FileRow {
  return eRepo
    ? { action: "abre-diff", tip: `${path}\n${t("Abrir o diff")}` }
    : { action: "explica", tip: `${path}\n${t(NO_REPO)}` };
}
