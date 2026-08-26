/**
 * Support bundle — the pure half of "Relatar um problema".
 *
 * The zip itself is written by the backend (`src-tauri/src/support.rs`); what
 * lives here is the text around it: the file name the save dialog proposes
 * and the skeleton copied to the clipboard with the tracker link. The link is
 * **copied, never opened** — nothing in this app launches a browser (that
 * rule has a history: an Edge window blinking on every rebuild).
 */

import { t } from "./i18n";

/** The public tracker's new-issue page. */
export const TRACKER_URL = "https://github.com/alanadson/yard/issues/new";

const pad = (n: number) => String(n).padStart(2, "0");

/** `yard-suporte-<yyyy-mm-dd-hhmm>.zip`, local time, so a folder of them sorts by creation. */
export function bundleFileName(now: Date): string {
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `yard-suporte-${stamp}.zip`;
}

export interface IssueSummary {
  /** App version, when a bundle has been generated (it comes back with one). */
  version?: string;
  /** File name of the generated bundle, to name in the "attach" line. */
  bundleName?: string;
}

/**
 * The Markdown skeleton pasted into the issue: the three things a maintainer
 * needs, in the order they read them. Neutral enough for either language on
 * the tracker; the labels are the product's.
 */
export function issueBody(summary: IssueSummary): string {
  const bundle = summary.bundleName ?? t("gerado em Configurações → Dados e backup");
  return [
    t("Versão: {version}", { version: summary.version ?? "—" }),
    "",
    t("O que aconteceu:"),
    "",
    t("Passos:"),
    "1.",
    "2.",
    "",
    t("Anexe o pacote de suporte ({bundle}).", { bundle }),
  ].join("\n");
}
