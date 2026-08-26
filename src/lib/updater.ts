/**
 * In-app updates — the pure rules.
 *
 * The plugin (`@tauri-apps/plugin-updater`) fetches `latest.json` from the
 * GitHub release, checks the signature and runs the installer. What is
 * decided here is everything around that call: whether it is time to ask,
 * whether an answer is worth showing, and what the screen says about it.
 * Kept out of the store so the rules can be tested with numbers.
 */

/** kv keys — text, like every preference. */
import { t } from "./i18n";

export const KV_LAST_CHECK = "updater.lastCheckAt";
export const KV_SKIP = "updater.skipVersion";

/** Automatic checks: every six hours while the app is open. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * The first check waits half a minute after boot: the terminals that
 * auto-start, the workspace load and the agent detection own that window.
 */
export const FIRST_CHECK_DELAY_MS = 30_000;

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  /** `""` for a final release; the tag after `-` otherwise. */
  pre: string;
}

function parse(version: string): Parsed | null {
  const v = version.trim().replace(/^v/, "");
  const dash = v.indexOf("-");
  const core = dash === -1 ? v : v.slice(0, dash);
  const pre = dash === -1 ? "" : v.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const [major, minor, patch] = parts.map(Number);
  return { major, minor, patch, pre };
}

function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A release outranks any pre-release of the same numbers.
  if (a.pre === "" && b.pre !== "") return 1;
  if (a.pre !== "" && b.pre === "") return -1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}

/**
 * Whether `remote` is strictly newer than `current`. What does not parse as
 * `major.minor.patch[-pre]` is not an update: the plugin would refuse it as
 * well, but the screen must not announce it first.
 */
export function isNewer(current: string, remote: string): boolean {
  const c = parse(current);
  const r = parse(remote);
  if (!c || !r) return false;
  return compare(r, c) > 0;
}

/**
 * The answer the store keeps after the plugin said "there is one": a version
 * the user chose to ignore stays quiet — per version, so the next release is
 * offered again — unless the user asked for the check by hand.
 */
export function shouldOffer(input: {
  version: string;
  skipVersion: string | null;
  manual: boolean;
}): boolean {
  if (input.manual) return true;
  if (!input.skipVersion) return true;
  const a = parse(input.skipVersion);
  const b = parse(input.version);
  if (!a || !b) return input.skipVersion !== input.version;
  return compare(a, b) !== 0;
}

/**
 * Time for another automatic check. A clock that moved backwards (a VM
 * restored, a manual clock fix) makes `lastCheckAt` land in the future; that
 * is treated as "never checked", not as "wait until the future comes".
 */
export function checkDue(input: {
  lastCheckAt: number;
  now: number;
  everyMs?: number;
}): boolean {
  const every = input.everyMs ?? CHECK_EVERY_MS;
  if (!input.lastCheckAt) return true;
  if (input.lastCheckAt > input.now) return true;
  return input.now - input.lastCheckAt >= every;
}

export interface UpdateSummary {
  title: string;
  /** Up to three lines of the release notes, markdown markers stripped. */
  notes: string[];
}

const NOTE_LINES = 3;

/** What the bar and the Settings row say about the version on offer. */
export function updateSummary(version: string, body: string | undefined): UpdateSummary {
  const notes = (body ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(#+|[-*+]|\d+\.)\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, NOTE_LINES);
  return { title: t("Versão {version} disponível", { version }), notes };
}

/**
 * The line under the offer while the bytes move. A percentage when the
 * manifest told the size, kilobytes when it did not (a redirect without
 * `Content-Length`), and the "will reopen" reassurance once the installer
 * has the file — the app exits by itself from there.
 */
export function progressLabel(
  phase: string,
  progress: { downloaded: number; total: number | null },
): string | null {
  if (phase === "installing") return t("Instalando… o Yard vai reabrir sozinho.");
  if (phase !== "downloading") return null;
  if (progress.total && progress.total > 0) {
    const pct = Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
    return t("Baixando… {pct}%", { pct });
  }
  return t("Baixando… {kb} KB", { kb: Math.round(progress.downloaded / 1024) });
}

/** `lastCheckAt` as stored in kv, or 0 when absent or unreadable. */
export function parseLastCheck(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
