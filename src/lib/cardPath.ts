/**
 * The absolute path behind a file card, for the clipboard and the OS.
 *
 * A card stores a `/`-separated path relative to a root (its own, or the
 * project's), which is what keeps it portable across checkouts. Whoever
 * wants to paste it into a terminal or reveal it in the file manager wants
 * the opposite: one absolute path, in the separators the project itself uses.
 */
import type { CanvasItem } from "./canvas";

/** `root` + `rel`, in the root's own separator style. */
export function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const tail = rel.replace(/^[\\/]+/, "").replace(/\//g, sep);
  return tail ? `${base}${sep}${tail}` : base;
}

/**
 * Where the card's file (or folder) lives on disk, or `null` when the card
 * is not about a file, or when nothing can anchor its relative path (a board
 * with no project, and no root on the card).
 */
export function itemAbsolutePath(it: CanvasItem, projectRoot: string): string | null {
  if (it.type !== "media" && it.type !== "tree" && it.type !== "doc") return null;
  const root = (it.root ?? projectRoot).trim();
  if (!root) return null;
  return joinPath(root, it.path);
}
