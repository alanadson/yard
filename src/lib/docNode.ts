/**
 * Document cards: a source file open on the board, next to the agent that
 * is editing it.
 *
 * The card is an address, never text: `root` + `path`, the same pair a media
 * card carries, so it stays portable across checkouts and never duplicates
 * the buffer. The text lives in the editor store, which is also what keeps
 * the card and a tab of the same file showing the same characters.
 */
import type { Box, CanvasItem } from "./canvas";

export type DocItem = Extract<CanvasItem, { type: "doc" }>;

export const DOC_MIN_W = 260;
export const DOC_MIN_H = 160;
export const DOC_DEFAULT_W = 560;
export const DOC_DEFAULT_H = 420;

/** Longest pinned name that still reads on the card's header. */
export const DOC_NAME_MAX = 48;

/** The name on the card's header: the pinned one, or the file's own. */
export function docNodeName(it: DocItem): string {
  if (it.name && it.name.trim()) return it.name.trim();
  const path = it.path.replace(/\\/g, "/");
  return path.slice(path.lastIndexOf("/") + 1) || "arquivo";
}

/** A document card's rectangle at a point, centred on it. */
export function docBoxAt(x: number, y: number): Box {
  return {
    x: x - DOC_DEFAULT_W / 2,
    y: y - DOC_DEFAULT_H / 2,
    w: DOC_DEFAULT_W,
    h: DOC_DEFAULT_H,
  };
}
