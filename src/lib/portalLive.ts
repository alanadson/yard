/**
 * "Ao vivo": a portal that reloads itself when the site behind it changes.
 *
 * The gap this closes: an agent edits the project and the page on the canvas
 * keeps showing the old build. A dev server with HMR patches itself; anything
 * else — a production bundle served by Express, a static folder, a framework
 * without HMR — sits there stale until someone clicks reload.
 *
 * How it decides, and why it is not the file watcher alone:
 *
 * - **The server answers, not the disk.** A file changing means an agent
 *   *wrote* something, not that the site serves it: a build takes seconds and
 *   reloading mid-build shows half a site. So every check asks the address
 *   itself for a fingerprint (`portal_probe`: `ETag`/`Last-Modified` first,
 *   body hash as the fallback) and reloads only when that answer moves.
 * - **The file watcher is the trigger, not the verdict.** `files://activity`
 *   only makes the next check happen sooner; a slow heartbeat catches
 *   whatever the watcher misses (a build the agent ran in a folder we do not
 *   watch, `npm run build` writing into `dist/`, which is filtered).
 * - **HMR is left alone.** Vite's index.html does not change when a module is
 *   patched, so a portal pointed at a dev server never gets reloaded out from
 *   under its own hot updates.
 *
 * Only loopback/private addresses take part: reloading a site on the internet
 * because a local file moved is nonsense.
 */
import { hostKind } from "./advertised";
import { ipc, on } from "./ipc";

/** Heartbeat between checks while nothing is announcing itself. */
const IDLE_MS = 4000;
/** After a file event: enough for a writer to finish, short enough to feel live. */
const NUDGE_MS = 700;
/** A server that stopped answering is not a reason to keep hammering it. */
const BACKOFF_MS = 15000;

interface Watch {
  id: string;
  url: string;
  /** Last answer from the address; `null` until the first successful probe. */
  seen: string | null;
  /** Consecutive failures — the address went down, or never was up. */
  fails: number;
  timer: number | null;
  /** A probe is in flight; the timer must not start a second one. */
  busy: boolean;
}

const watches = new Map<string, Watch>();
/** The shared `files://activity` listener, `dead` once nobody wants it. */
let sub: { off: (() => void) | null; dead: boolean } | null = null;

/** Is this an address a local project could be serving? */
export function isLocalUrl(url: string): boolean {
  try {
    return hostKind(new URL(url).hostname) !== null;
  } catch {
    return false;
  }
}

/**
 * Starts (or retargets) the auto-reload of one portal. Returns the stop
 * function, so a component can hand it straight to its effect cleanup.
 */
export function watchPortal(id: string, url: string): () => void {
  const found = watches.get(id);
  if (found) {
    if (found.url !== url) {
      found.url = url;
      // A new address is a new baseline: the first probe of a page nobody has
      // seen yet must not be read as "it changed" and reload it on arrival.
      found.seen = null;
      found.fails = 0;
    }
  } else {
    watches.set(id, { id, url, seen: null, fails: 0, timer: null, busy: false });
    subscribeActivity();
  }
  schedule(id, IDLE_MS);
  return () => unwatchPortal(id);
}

export function unwatchPortal(id: string): void {
  const w = watches.get(id);
  if (!w) return;
  if (w.timer !== null) window.clearTimeout(w.timer);
  watches.delete(id);
  if (watches.size === 0) unsubscribeActivity();
}

function schedule(id: string, delay: number): void {
  const w = watches.get(id);
  if (!w) return;
  if (w.timer !== null) window.clearTimeout(w.timer);
  w.timer = window.setTimeout(() => {
    w.timer = null;
    void check(id);
  }, delay);
}

async function check(id: string): Promise<void> {
  const w = watches.get(id);
  if (!w || w.busy) return;
  w.busy = true;
  try {
    const print = await ipc.portalProbe(w.url);
    // It may have been retargeted or closed while the probe was in flight.
    const now = watches.get(id);
    if (!now || now.url !== w.url) return;
    now.fails = 0;
    if (now.seen === null) {
      now.seen = print;
    } else if (now.seen !== print) {
      now.seen = print;
      void ipc.portalReload(id).catch(() => {});
    }
  } catch {
    const now = watches.get(id);
    if (now) now.fails += 1;
  } finally {
    const now = watches.get(id);
    if (now) {
      now.busy = false;
      schedule(id, now.fails > 2 ? BACKOFF_MS : IDLE_MS);
    }
  }
}

/**
 * One listener for every portal: the feed is global and the store already
 * fans it out to the tree and the editor.
 */
function subscribeActivity(): void {
  if (sub) return;
  const mine = { off: null as (() => void) | null, dead: false };
  sub = mine;
  void on
    .filesActivity(() => {
      for (const id of watches.keys()) schedule(id, NUDGE_MS);
    })
    .then((off) => {
      // The last portal may have left while the subscription was on its way.
      if (mine.dead) off();
      else mine.off = off;
    })
    .catch(() => {
      if (sub === mine) sub = null;
    });
}

function unsubscribeActivity(): void {
  if (!sub) return;
  sub.dead = true;
  sub.off?.();
  sub = null;
}
