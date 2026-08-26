/**
 * The dialog rules that are not drawing: what an exit does with a filled-in
 * form, where Tab goes, and which press on the backdrop counts as leaving.
 *
 * They live outside the component because both had three implementations in
 * `Modal.tsx` — one per gesture — and they diverged: the header's × discarded
 * the filled form that the backdrop and Esc protected, and Tab escaped the
 * dialog whenever focus was on the `body` (which happens when clicking any
 * non-focusable text in there).
 */

/** What to do with an attempt to leave. */
export type ExitAction = "close" | "warn";

/**
 * Leaving with something filled in warns once; the second attempt (within the
 * warning window) discards. Holds for all three gestures — backdrop, Esc and
 * the ×.
 */
export function exitGesture(state: { dirty: boolean; warned: boolean }): ExitAction {
  return state.dirty && !state.warned ? "warn" : "close";
}

/**
 * Where Tab sends focus, or `null` when the browser already does the right
 * thing on its own (stepping from one focusable to its neighbour, inside the
 * dialog).
 *
 * `atual` outside the list covers the case that was missing: with focus on
 * the `body`, the next Tab went to the first focusable **in the document** —
 * the title bar, behind the backdrop.
 */
export function focusAfterTab<T>(
  items: readonly T[],
  current: T | null | undefined,
  shift: boolean,
): T | null {
  if (items.length === 0) return null;
  const firstOne = items[0];
  const last = items[items.length - 1];
  const inside = current != null && items.includes(current);
  if (!inside) return shift ? last : firstOne;
  if (shift && current === firstOne) return last;
  if (!shift && current === last) return firstOne;
  return null;
}

/**
 * Whether a press on the backdrop is an exit. Only the primary button: with
 * the right one the gesture is "open the menu", and closing the dialog from
 * under it would be the wrong answer. Two frames read the backdrop — `Modal`
 * and the Settings window — so the rule is written once.
 */
export function backdropPressExits(button: number): boolean {
  return button === 0;
}
