/**
 * The live drag of the vector layer (`ItemsLayer`), as a rule it paints from.
 *
 * A drag moves one stroke or a handful, and the offset changes on every frame
 * of the gesture. Rebuilding the element of every item on the board for each
 * of those frames made the cost of a drag grow with the board instead of with
 * the selection. So the layer keeps one list built at rest, and a frame swaps
 * in new elements only for the items being dragged: every other entry is the
 * very same value it was, which lets React skip it without comparing props.
 */

/** The live drag: which items move, and by how much in world px. */
export interface VectorDrag {
  ids: ReadonlySet<string>;
  dx: number;
  dy: number;
}

/** The offset the live drag gives one item: the gesture's for a member of it, none otherwise. */
export function dragShift(drag: VectorDrag | null, id: string): { dx: number; dy: number } {
  const shift = drag?.ids.has(id) ? drag : null;
  return { dx: shift?.dx ?? 0, dy: shift?.dy ?? 0 };
}

/**
 * `base` with the dragged entries rebuilt by `rebuild(index)`.
 *
 * `base` and `items` run in parallel: entry `i` is what this layer paints for
 * `items[i]`, and `null` is an item another layer draws, which stays `null`
 * even when it is part of the gesture. With nothing of this layer being
 * dragged, the answer is `base` itself.
 */
export function withDragged<T>(
  base: readonly (T | null)[],
  items: readonly { id: string }[],
  drag: VectorDrag | null,
  rebuild: (index: number) => T,
): readonly (T | null)[] {
  if (!drag) return base;
  let out: (T | null)[] | null = null;
  for (let i = 0; i < base.length; i++) {
    if (base[i] === null || !drag.ids.has(items[i].id)) continue;
    out ??= base.slice();
    out[i] = rebuild(i);
  }
  return out ?? base;
}
