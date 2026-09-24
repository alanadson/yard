/**
 * A store selector that keeps handing back its previous answer while the new
 * one is equivalent.
 *
 * Zustand re-renders a component when its selector's answer changes by
 * identity. That leaves two bad options for a component that paints a slice
 * of a busy store: return the store's own field (the whole `groups` array) and
 * re-render on every write to any element of it, including the canvas and
 * viewport writes a keystroke in a board note makes; or build the slice inside
 * the selector and hand Zustand a fresh array on every call, which is the
 * "Maximum update depth exceeded" loop. This is the third one: build the
 * projection, and when `same` says it is equivalent to the last one, return
 * the last one. The component re-renders exactly when what it reads changes.
 *
 * `same` is the whole contract. It must only call two answers equivalent when
 * every field the component reads is equal, because the kept answer is what
 * gets painted.
 *
 * One selector per component instance (create it in a `useMemo`): it
 * remembers one previous answer, and two components sharing it would keep
 * swapping each other's.
 */
export function stableSelect<S, T>(
  select: (state: S) => T,
  same: (prev: T, next: T) => boolean,
): (state: S) => T {
  let kept = false;
  let last: T;
  return (state) => {
    const next = select(state);
    if (kept && same(last, next)) return last;
    kept = true;
    last = next;
    return next;
  };
}

/**
 * The same elements, by identity, in the same order: what a list slice looks
 * like when nothing in it was rewritten. The store replaces a row object on
 * every change to it (`{ ...row, ...patch }`), so identity is the change
 * detector, and an untouched row keeps its object.
 */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
