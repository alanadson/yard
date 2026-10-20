import { sameItems } from "./stableSelect";

/** Reuse unchanged JSON records received across the IPC boundary. */
export function reconcileSnapshot<T extends object>(
  previous: T[], incoming: T[], keyOf: (item: T) => string,
): T[] {
  const byKey = new Map(previous.map((item) => [keyOf(item), item]));
  const next = incoming.map((item) => {
    const kept = byKey.get(keyOf(item));
    return kept && JSON.stringify(kept) === JSON.stringify(item) ? kept : item;
  });
  return sameItems(previous, next) ? previous : next;
}
