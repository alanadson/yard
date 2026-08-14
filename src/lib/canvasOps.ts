/**
 * Transformations of the canvas graph: `CanvasData -> CanvasData`, pure.
 *
 * These four shapes were written inline over and over — "delete this item and
 * every wire touching it" four times, "patch the item with this id" about ten
 * — across the CLI bridge and the canvas component. Inline, each copy has to
 * remember the same detail: a connection whose endpoint disappears is junk
 * that survives a reload and draws an arrow to nowhere.
 *
 * Nothing here touches a store, IPC or the DOM; both writers (the user's
 * `commit` and the agent's `commitCanvasExternal`) hand the result to their
 * own committer.
 */
import { nanoid } from "nanoid";

import type { CanvasData, CanvasItem } from "./canvas";

/** Default wire colour — a neutral that reads as plumbing, not as drawing. */
export const CONNECTION_COLOR = "#6b6b6b";

/** Appends items, in order. */
export function addItems(c: CanvasData, ...items: CanvasItem[]): CanvasData {
  return { ...c, items: [...c.items, ...items] };
}

/** A new connection item between two ids. */
export function connection(
  from: string,
  to: string,
  color = CONNECTION_COLOR,
): CanvasItem {
  return { id: nanoid(8), type: "connection", from, to, color };
}

/** Is there already a wire between these two, in either direction? */
export function isConnected(c: CanvasData, a: string, b: string): boolean {
  return c.items.some(
    (i) =>
      i.type === "connection" &&
      ((i.from === a && i.to === b) || (i.from === b && i.to === a)),
  );
}

/** Replaces the item with `id`, leaving the rest untouched. */
export function patchItem(
  c: CanvasData,
  id: string,
  fn: (it: CanvasItem) => CanvasItem,
): CanvasData {
  return { ...c, items: c.items.map((i) => (i.id === id ? fn(i) : i)) };
}

/** Shallow field patch of an item of a known type. */
export function patchItemOfType<T extends CanvasItem["type"]>(
  c: CanvasData,
  id: string,
  type: T,
  patch: Partial<Extract<CanvasItem, { type: T }>>,
): CanvasData {
  return patchItem(c, id, (i) =>
    i.type === type ? ({ ...i, ...patch } as CanvasItem) : i,
  );
}

/**
 * Removes an item **and every connection that referenced it**.
 *
 * The second half is the part that gets forgotten: a wire pointing at a
 * deleted note is not harmless — it is persisted, it survives a reload, and
 * `connectedNotes` will keep walking through it.
 */
export function removeItemAndEdges(c: CanvasData, id: string): CanvasData {
  return {
    ...c,
    items: c.items.filter(
      (i) =>
        i.id !== id &&
        !(i.type === "connection" && (i.from === id || i.to === id)),
    ),
  };
}

/**
 * Same, for a terminal card: drops its rectangle, its role, its routines and
 * its wires. A card lives in `nodes`, not in `items`, so it needs its own.
 */
export function removeNodeAndEdges(c: CanvasData, id: string): CanvasData {
  const nodes = { ...c.nodes };
  delete nodes[id];
  const roles = { ...(c.roles ?? {}) };
  delete roles[id];
  return {
    ...c,
    nodes,
    roles: Object.keys(roles).length ? roles : undefined,
    routines: (c.routines ?? []).filter((r) => r.terminalId !== id),
    items: c.items.filter(
      (i) => !(i.type === "connection" && (i.from === id || i.to === id)),
    ),
  };
}

/** Moves an item to the front or the back of the paint order. */
export function reorderItem(
  c: CanvasData,
  id: string,
  dir: "front" | "back",
): CanvasData {
  const idx = c.items.findIndex((i) => i.id === id);
  if (idx < 0) return c;
  const items = [...c.items];
  const [moved] = items.splice(idx, 1);
  if (dir === "front") items.push(moved);
  else items.unshift(moved);
  return { ...c, items };
}

/** Sets or clears a keyed entry, dropping the map when it empties. */
export function setEntry(
  map: Record<string, string> | undefined,
  key: string,
  value: string | undefined,
): Record<string, string> | undefined {
  const next = { ...(map ?? {}) };
  if (value && value.trim()) next[key] = value.trim();
  else delete next[key];
  return Object.keys(next).length ? next : undefined;
}
