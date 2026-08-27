/**
 * Who is working, and who is only waiting for it.
 *
 * A panel that fires one action at a time keeps the id of the action in
 * flight (`null` when idle). Every button then asks this what it should look
 * like: the one that fired announces the work, the others refuse the click
 * without pretending to be doing it.
 *
 * See `src/lib/busy.test.ts` for why the shared boolean it replaces was a
 * defect and not a shortcut.
 */

/** What a single button is, while the panel has one action in flight. */
export type BusyState =
  /** This button fired the action: it spins and says so. */
  | "rodando"
  /** Another button fired it: this one only refuses the click. */
  | "bloqueado"
  /** Nothing in flight. */
  | "livre";

/**
 * `running` is the id of the action in flight, or `null`/`""` when the panel
 * is idle — an empty id never marks a button as running, however the caller
 * initialised its state.
 */
export function busyState(running: string | null, id: string): BusyState {
  if (!running) return "livre";
  return running === id ? "rodando" : "bloqueado";
}

/** Spins and carries `aria-busy` — the button the user pressed. */
export function isBusy(state: BusyState): boolean {
  return state === "rodando";
}

/** Refuses the click: both the one working and the ones waiting on it. */
export function refusesClick(state: BusyState): boolean {
  return state !== "livre";
}
