/**
 * File-tree cards (§14): the project explorer, on the board, next to the
 * agents working in it.
 *
 * §14.1 asks for something the side panel structurally cannot give: **more
 * than one at a time**, each keeping its own root, its own open folders, its
 * own mode and its own selection. The panel's state is global (one `root`, one
 * `dirs`, one `expanded` in `stores/editorStore`), so a card that reused it
 * would make every card on the board expand and collapse together.
 *
 * So a tree card carries its own state on the item, and reads disk through
 * `ipc.fsListDir` itself. What it does **not** carry is the listing: that is a
 * cache of what is on disk this second, it belongs in component state, and
 * writing it into `layoutJson` would persist a snapshot of a folder that
 * changes under it every time an agent saves a file.
 */
import type { CanvasItem } from "./canvas";

export type TreeItem = Extract<CanvasItem, { type: "tree" }>;

/** The four faces of §14.2. */
export type TreeMode = "list" | "grid" | "changes" | "graph";

export const TREE_MODES: readonly TreeMode[] = ["list", "grid", "changes", "graph"];

export const TREE_MODE_LABEL: Record<TreeMode, string> = {
  list: "Lista",
  grid: "Grade",
  changes: "Alterações",
  graph: "Histórico",
};

export const TREE_MIN_W = 220;
export const TREE_MIN_H = 200;
export const TREE_DEFAULT_W = 320;
export const TREE_DEFAULT_H = 420;

/** Longest pinned name that still reads on the card's header. */
export const TREE_NAME_MAX = 48;

/** Commits asked for in the history mode. One screenful, plus room to scroll. */
export const TREE_LOG_LIMIT = 80;

export function isTreeMode(v: unknown): v is TreeMode {
  return typeof v === "string" && (TREE_MODES as readonly string[]).includes(v);
}

/**
 * The name on the header: the pinned one, the folder's own, or the project's
 * — `path` is `""` at the root, and "Arquivos" says more there than a blank.
 */
export function treeNodeName(it: TreeItem): string {
  if (it.name && it.name.trim()) return it.name.trim();
  const path = it.path.replace(/\/+$/, "");
  if (!path) return "Arquivos";
  return path.slice(path.lastIndexOf("/") + 1) || "Arquivos";
}

/** Is this folder open in **this** card? */
export function isOpen(it: TreeItem, path: string): boolean {
  return !!it.expanded?.includes(path);
}

/** The open-folder list with `path` flipped. */
export function toggled(it: TreeItem, path: string): string[] {
  const open = it.expanded ?? [];
  return open.includes(path) ? open.filter((p) => p !== path) : [...open, path];
}
