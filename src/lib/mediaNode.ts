/**
 * Media cards (§52): a picture, a video, a PDF or an audio file sitting on the
 * board next to the agents that care about it.
 *
 * The point is proximity. A spec with the mock-up beside it, a bug with the
 * screenshot beside it, a design reference beside the agent implementing it —
 * §52 calls it "manter especificações e referências próximas dos agentes", and
 * that is exactly what the file explorer in a side panel cannot do.
 *
 * **Nothing is copied.** The card stores an address, never bytes: a 300 MB
 * video on a board must not become 300 MB in `layoutJson`. The bytes travel
 * over `yardfile://` (`src-tauri/src/media.rs`), the same protocol the file
 * viewer and a note's images use — the webview fetches its own chunks, so
 * seeking works and the IPC never sees a frame.
 *
 * That protocol takes a **root** plus a path under it, which is what
 * `splitForRoot` is for.
 */
import type { Box, CanvasItem } from "./canvas";

export type MediaItem = Extract<CanvasItem, { type: "media" }>;

export const MEDIA_MIN_W = 120;
export const MEDIA_MIN_H = 90;
export const MEDIA_DEFAULT_W = 420;
export const MEDIA_DEFAULT_H = 300;

/** Longest pinned name that still reads on the card's header. */
export const MEDIA_NAME_MAX = 48;

/** Windows and POSIX separators, as one. Stored paths are always `/`. */
function slashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Case-insensitive on Windows drive paths, exact everywhere else.
 *
 * The file dialog hands back `C:\workspace\…` where the project row says
 * `C:\Workspace\…` — the same folder, and a user must not be able to tell the
 * difference from the card. A POSIX path stays case-sensitive, because there
 * `/A` and `/a` really are two folders.
 */
function sameRootPrefix(path: string, root: string): boolean {
  const windows = /^[a-z]:\//i.test(root);
  const a = windows ? path.toLowerCase() : path;
  const b = windows ? root.toLowerCase() : root;
  // The separator is part of the test on purpose: `yard-old` is not inside
  // `yard`, and a bare `startsWith` would file it as `-old/x.png`.
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

/**
 * Cuts an absolute path into the `{root, path}` pair the protocol wants.
 *
 * Inside `projectRoot` the card carries no root of its own — that absence is
 * what makes it portable, so a score applied in another checkout resolves
 * against the new project. Outside it (or on a board, which has no project)
 * the card carries the file's own folder, because nothing else could serve as
 * an anchor.
 */
export function splitForRoot(
  absolute: string,
  projectRoot: string,
): { root?: string; path: string } {
  const full = slashes(absolute.trim()).replace(/\/+$/, "");
  const root = slashes(projectRoot.trim()).replace(/\/+$/, "");
  if (root && sameRootPrefix(full, root)) {
    return { path: full.slice(root.length).replace(/^\/+/, "") };
  }
  const cut = full.lastIndexOf("/");
  if (cut <= 0) return { path: full };
  return { root: full.slice(0, cut), path: full.slice(cut + 1) };
}

/** The name on the card's header: the pinned one, or the file's own. */
export function mediaNodeName(it: MediaItem): string {
  if (it.name && it.name.trim()) return it.name.trim();
  const path = slashes(it.path);
  return path.slice(path.lastIndexOf("/") + 1) || "arquivo";
}

/** A media card's rectangle at the drop point, centered on it. */
export function mediaBoxAt(x: number, y: number): Box {
  return {
    x: x - MEDIA_DEFAULT_W / 2,
    y: y - MEDIA_DEFAULT_H / 2,
    w: MEDIA_DEFAULT_W,
    h: MEDIA_DEFAULT_H,
  };
}
