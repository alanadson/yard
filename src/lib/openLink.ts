/**
 * Where a link clicked inside the app ends up.
 *
 * The app has two possible destinations and they do not mix:
 *
 * - **web address** → a portal on the canvas, the only place a page runs
 *   here (`new-portal`);
 * - **file path** → `open_external`, which opens in the system's default
 *   application and therefore only accepts a path that exists on disk.
 *
 * This exists because the notebook sent the web down the file path: since
 * `https://…` is never an existing path, every note link answered "esse
 * arquivo não está mais no disco". The file editor already did it right, and
 * now both go through the same function.
 */
import { normalizePortalUrl } from "./portals";
import { useUI } from "../stores/uiStore";

/** `//host` and `www.host` are web addresses just as much as `https://host`. */
const WEB = /^(https?:\/\/|\/\/|www\.)/i;

/**
 * The address ready to open, or `null` when this is not web.
 *
 * Deliberately shuts the door on any other scheme (`file:`, `javascript:`,
 * `vscode:`…): note links are text an agent may have written, and "opening"
 * one of them must not turn into executing anything.
 */
export function webAddress(href: string): string | null {
  const s = href.trim();
  if (!s || !WEB.test(s)) return null;
  const url = normalizePortalUrl(s.startsWith("//") ? `https:${s}` : s);
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Opens the address as a portal. Returns `false` (doing nothing) when what
 * arrived is not a web address — it is up to the caller to say what to do
 * with that, which differs on each surface.
 */
export function openWebAddress(href: string): boolean {
  const url = webAddress(href);
  if (!url) return false;
  useUI.getState().openModal("new-portal", { url });
  return true;
}
