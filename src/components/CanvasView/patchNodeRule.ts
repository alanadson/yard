import type { Box, CanvasNode } from "../../lib/canvas";

/**
 * The next `nodes` entry of a card after one field is patched.
 *
 * Rebuilt field by field so an explicit `undefined` really removes the key
 * instead of persisting as `"color": null` in the workspace JSON. The live
 * rectangle goes in with it: the card may still be in an automatic position
 * (nothing in `nodes` yet), and picking a colour must not snap it back to
 * its computed slot. Every optional field of `CanvasNode` has to be listed
 * here: forgetting one (as `dock` and `contentHidden` once were) makes a
 * colour pick silently undock the card or reveal hidden content.
 */
export function nextNode(prev: CanvasNode, patch: Partial<CanvasNode>, rect: Box): CanvasNode {
  const merged = { ...prev, ...patch };
  const next: CanvasNode = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  if (merged.dock) next.dock = merged.dock;
  if (merged.contentHidden) next.contentHidden = true;
  if (merged.color) next.color = merged.color;
  if (merged.fontSize != null) next.fontSize = merged.fontSize;
  if (merged.z != null) next.z = merged.z;
  if (merged.pinned) next.pinned = true;
  if (merged.restore) next.restore = merged.restore;
  return next;
}
