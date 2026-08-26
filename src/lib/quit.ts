/**
 * "Sair" from outside the window's X — the tray menu and the palette.
 *
 * Only `App` knows the exit flow (flush notes, save the workspace, ask about
 * live agents, destroy the window), and it installs that flow here once it
 * is mounted. Everyone else calls `requestQuit` and gets told whether
 * anybody was there to answer: before boot there is no flow to run, and
 * silently doing nothing is exactly what a "Sair" must never do.
 */
let handler: (() => void) | null = null;

/** `App` installs its exit flow here; `null` on unmount. */
export function setQuitHandler(fn: (() => void) | null): void {
  handler = fn;
}

/** Runs the exit flow if one is installed. `false` = nobody to ask. */
export function requestQuit(): boolean {
  if (!handler) return false;
  handler();
  return true;
}
