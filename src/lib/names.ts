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
  for (const item of items) {
    const base = nameOf(item);
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    labels.set(item.id, n === 1 ? base : `${base} (${n})`);
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
