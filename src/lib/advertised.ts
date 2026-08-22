/**
 * URLs a process announces on its own output — `Local: http://localhost:5173`.
 *
 * The gap: an agent starts a dev server and the address only exists as text
 * in a terminal the user then has to find, read and retype into a portal.
 * Scanning the stream turns "o servidor subiu" into one click.
 *
 * Two rules make it survive a real PTY:
 *
 * - **Scan whole lines only.** Output arrives in chunks that cut wherever the
 *   read landed, so a URL (or the escape sequence around it) can be split in
 *   half. Text is buffered until a newline and only then scanned.
 * - **Strip the terminal control language first.** Colour and cursor
 *   sequences sit *inside* the URL as often as around it — a coloured
 *   `http://localhost:5173` is `http://localhost:\x1b[1m5173\x1b[0m` on the wire.
 *
 * Only loopback and private addresses are kept. Every agent prints links to
 * documentation; those are not "your app is running here", and offering to
 * open them would make the feature noise.
 */

export type HostKind = "loopback" | "private";

export interface AdvertisedUrl {
  /** `http://localhost:5173` — scheme, host and port, no path. */
  origin: string;
  host: string;
  port: number;
  kind: HostKind;
  /** Epoch ms of the last time this origin showed up. */
  at: number;
}

/** Per-PTY buffer cap. A line longer than this is not a URL announcement. */
const BUFFER_CAP = 4096;
/** Sanity bound on a single candidate before `new URL` sees it. */
const URL_MAX = 2048;

// eslint-disable-next-line no-control-regex -- the point of this module
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESC_SINGLE = /\x1b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`)\]},;]+/gi;

/** Removes the escape sequences that would otherwise cut a URL in half. */
export function stripTerminalControls(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_SINGLE, "")
    .replace(CONTROL, "");
}

/**
 * Where a host lives. `null` = somewhere on the internet, which this module
 * deliberately ignores.
 */
export function hostKind(host: string): HostKind | null {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    name === "localhost" ||
    name === "::1" ||
    name === "0.0.0.0" ||
    name === "::" ||
    name.endsWith(".localhost") ||
    /^127\./.test(name)
  ) {
    return "loopback";
  }
  if (
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^169\.254\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  ) {
    return "private";
  }
  return null;
}

/**
 * A wildcard bind is not an address you can open. Windows resolves
 * `http://0.0.0.0:3000` inconsistently; `localhost` always works.
 */
function reachableHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare === "0.0.0.0" || bare === "::" ? "localhost" : host;
}

/** Every announced address in a block of already-clean text, in order. */
export function scanUrls(text: string, at = Date.now()): AdvertisedUrl[] {
  const found: AdvertisedUrl[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CANDIDATE)) {
    const raw = match[0];
    if (raw.length > URL_MAX) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const kind = hostKind(url.hostname);
    if (!kind) continue;
    const host = reachableHost(url.hostname);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const origin = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
    if (seen.has(origin)) continue;
    seen.add(origin);
    found.push({ origin, host, port, kind, at });
  }
  return found;
}

/**
 * Everything announced inside one group, whichever terminal printed it.
 *
 * A project usually has one dev server and several agents working on it: the
 * CLI that ran it printed the address, the others never will, and offering
 * the portal only on the first one reads as a broken button on the rest.
 *
 * Newest first (the address that just came up is the one about to be opened),
 * one entry per origin, and the **same array back** when nothing moved —
 * this feeds a selector on every card of the board.
 */
export function groupAdvertised(
  byTerminal: Readonly<Record<string, readonly AdvertisedUrl[]>>,
  groupOf: (terminalId: string) => string | null | undefined,
  groupId: string,
  current: readonly AdvertisedUrl[] = [],
  cap = 6,
): AdvertisedUrl[] {
  const seen = new Set<string>();
  const out: AdvertisedUrl[] = [];
  for (const id of Object.keys(byTerminal)) {
    if (groupOf(id) !== groupId) continue;
    for (const u of byTerminal[id]) {
      if (seen.has(u.origin)) continue;
      seen.add(u.origin);
      out.push(u);
    }
  }
  // Stable sort: two addresses printed by the same banner keep the order they
  // were printed in (vite prints `Local` before `Network`, and `Local` is the
  // one you want).
  out.sort((a, b) => b.at - a.at);
  const capped = out.slice(0, cap);
  const same =
    capped.length === current.length &&
    capped.every((u, i) => u.origin === current[i].origin);
  return same ? (current as AdvertisedUrl[]) : capped;
}

export interface UrlScanner {
  /** Feeds a raw PTY chunk; returns what became visible with this one. */
  feed: (chunk: string, at?: number) => AdvertisedUrl[];
}

export function createUrlScanner(): UrlScanner {
  let tail = "";
  return {
    feed(chunk, at = Date.now()) {
      if (!chunk) return [];
      // Keep only the last `BUFFER_CAP` characters: a chunk bigger than the
      // buffer is a `cat` of something, not a startup banner.
      tail = (tail + chunk).slice(-BUFFER_CAP);
      const cut = Math.max(tail.lastIndexOf("\n"), tail.lastIndexOf("\r"));
      if (cut === -1) return [];
      const ready = tail.slice(0, cut + 1);
      tail = tail.slice(cut + 1);
      if (!ready.includes("://")) return [];
      return scanUrls(stripTerminalControls(ready), at);
    },
  };
}

/**
 * Folds new findings into what a terminal had already announced: the newest
 * batch on top, printed order kept inside it (vite prints `Local` before
 * `Network`, and `Local` is the one you want), one entry per origin, capped.
 *
 * Returns the **same array** when nothing changed — this runs on every output
 * chunk of every terminal, and a new array each time would re-render the
 * whole board dozens of times per second.
 */
export function mergeAdvertised(
  current: readonly AdvertisedUrl[],
  found: readonly AdvertisedUrl[],
  cap = 6,
): AdvertisedUrl[] {
  if (found.length === 0) return current as AdvertisedUrl[];
  const known = new Set(current.map((u) => u.origin));
  const fresh = found.filter((u) => !known.has(u.origin));
  if (fresh.length === 0) return current as AdvertisedUrl[];
  return [...fresh, ...current].slice(0, cap);
}
