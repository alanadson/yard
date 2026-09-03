/**
 * What a drop on the board turns into.
 *
 * Files arrive from two doors (the project tree, the OS) with the same
 * shape: absolute paths. A picture, a video, a PDF or an audio file becomes a
 * media card; any other file a document card; a folder a tree card rooted at
 * itself. Several at once fan out by a step so none hides another.
 *
 * Pure: the entries and the point come in, the items come out. The canvas
 * commits them; `shellQuote` serves the other drop target, the terminal.
 */
import { nanoid } from "nanoid";

import { CANVAS_COLORS, type CanvasItem } from "./canvas";
import { DOC_DEFAULT_H, DOC_DEFAULT_W } from "./docNode";
import { MEDIA_DEFAULT_H, MEDIA_DEFAULT_W, splitForRoot } from "./mediaNode";
import { TREE_DEFAULT_H, TREE_DEFAULT_W } from "./treeNode";

/** Extensions the media card draws (`lib/media.ts` decides by MIME once the bytes are read). */
const MEDIA_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "svg",
  "ico",
  "tif",
  "tiff",
  "mp4",
  "webm",
  "mov",
  "mkv",
  "m4v",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "m4a",
  "aac",
  "pdf",
]);

export function isMediaPath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return !!m && MEDIA_EXT.has(m[1].toLowerCase());
}

export interface DropEntry {
  /** Absolute path, in whatever separators the source used. */
  path: string;
  dir?: boolean;
}

export type DropAction =
  | { kind: "media" | "doc"; path: string; root?: string }
  | { kind: "tree"; root: string };

/** Offset between two things dropped together, in world px. */
export const DROP_STEP = 40;

/** What each entry becomes, with a project file kept relative to its root. */
export function dropPlan(entries: readonly DropEntry[], projectRoot: string): DropAction[] {
  return entries.map((e) => {
    if (e.dir) return { kind: "tree", root: e.path.replace(/\\/g, "/").replace(/\/+$/, "") };
    const { root, path } = splitForRoot(e.path, projectRoot);
    return { kind: isMediaPath(e.path) ? "media" : "doc", path, ...(root ? { root } : {}) };
  });
}

/** The items to add, top-left at `at`, each one a step further down-right. */
export function dropItems(
  entries: readonly DropEntry[],
  at: { x: number; y: number },
  projectRoot: string,
): CanvasItem[] {
  const color = CANVAS_COLORS[0];
  return dropPlan(entries, projectRoot).map((a, i) => {
    const x = at.x + i * DROP_STEP;
    const y = at.y + i * DROP_STEP;
    if (a.kind === "tree") {
      return {
        id: nanoid(8),
        type: "tree",
        x,
        y,
        w: TREE_DEFAULT_W,
        h: TREE_DEFAULT_H,
        path: "",
        root: a.root,
        mode: "list",
        color,
      };
    }
    if (a.kind === "media") {
      return {
        id: nanoid(8),
        type: "media",
        x,
        y,
        w: MEDIA_DEFAULT_W,
        h: MEDIA_DEFAULT_H,
        path: a.path,
        ...(a.root ? { root: a.root } : {}),
        color,
      };
    }
    return {
      id: nanoid(8),
      type: "doc",
      x,
      y,
      w: DOC_DEFAULT_W,
      h: DOC_DEFAULT_H,
      path: a.path,
      ...(a.root ? { root: a.root } : {}),
      color,
    };
  });
}

/**
 * A path as a shell argument. Only wrapped when it has to be: a quoted path
 * pasted into a CLI that did not need quotes is still correct, but a bare
 * path with a space is two arguments.
 */
export function shellQuote(path: string): string {
  if (!/[\s"'()&;|<>^]/.test(path)) return path;
  return `"${path.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// the drag payload (the tree, a card, the board)
// ---------------------------------------------------------------------------

/** MIME of the JSON list of entries an in-app drag carries. */
export const DRAG_PATHS_MIME = "application/x-yard-paths";

/** The slice of `DataTransfer` the readers need, so a test can hand in a stub. */
export interface TransferLike {
  types: readonly string[];
  getData(type: string): string;
}

export function hasDragPaths(dt: TransferLike | null | undefined): boolean {
  return !!dt && Array.from(dt.types).includes(DRAG_PATHS_MIME);
}

/** The entries of an in-app drag, or nothing at all for junk. */
export function readDragPaths(dt: TransferLike | null | undefined): DropEntry[] {
  if (!hasDragPaths(dt)) return [];
  try {
    const raw = JSON.parse(dt!.getData(DRAG_PATHS_MIME)) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is DropEntry => !!e && typeof e === "object" && typeof (e as DropEntry).path === "string")
      .map((e) => ({ path: e.path, ...(e.dir ? { dir: true } : {}) }));
  } catch {
    return [];
  }
}

/** What the tree puts on the drag: the JSON for the board, plain text for anyone else. */
export function writeDragPaths(
  dt: { setData(type: string, data: string): void; effectAllowed: string },
  entries: readonly DropEntry[],
): void {
  dt.setData(DRAG_PATHS_MIME, JSON.stringify(entries));
  dt.setData("text/plain", entries.map((e) => e.path).join("\n"));
  dt.effectAllowed = "copy";
}
