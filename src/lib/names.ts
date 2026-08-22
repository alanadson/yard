/**
 * The addressing rule of the `yard` CLI, in one function.
 *
 * Terminals, notes and portals all answer to a display name, and duplicates
 * are disambiguated with " (2)", " (3)"… That name is what
 * `yard ask "Nome"` accepts, so the rule is a contract with agent scripts
 * that are already written — it had three independent implementations, which
 * is three ways for that contract to drift.
 *
 * It lives in its own module (rather than in `bridgeCore`) so that
 * `portals.ts` can use it without the two importing each other.
 */

export function uniqueLabels<T extends { id: string }>(
  items: T[],
  nameOf: (item: T) => string,
): Map<string, string> {
  const labels = new Map<string, string>();
  const seen = new Map<string, number>();
  // Every label already handed out, plus every name still to come. The suffix
  // used to be blind to both: with a card named literally "claude (2)" on the
  // board, the second "claude" got that same label — and `yard ask` delivered
  // to whichever came first in the list, silently. The address is a contract
  // with agent scripts; two owners cannot exist.
  const taken = new Set(items.map((i) => nameOf(i).toLowerCase()));
  for (const item of items) {
    const base = nameOf(item);
    const key = base.toLowerCase();
    let n = (seen.get(key) ?? 0) + 1;
    let label = n === 1 ? base : `${base} (${n})`;
    while (n > 1 && taken.has(label.toLowerCase())) {
      n += 1;
      label = `${base} (${n})`;
    }
    seen.set(key, n);
    taken.add(label.toLowerCase());
    labels.set(item.id, label);
  }
  return labels;
}

/** Case-insensitive lookup by display name, the way the CLI addresses things. */
export function byName<T extends { id: string }>(
  list: T[],
  labels: Map<string, string>,
  name: string,
): T | null {
  const q = name.trim().toLowerCase();
  return list.find((x) => labels.get(x.id)?.toLowerCase() === q) ?? null;
}
