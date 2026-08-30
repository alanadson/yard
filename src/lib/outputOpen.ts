/**
 * Taking a hit from the Busca back to where it was said.
 *
 * Finding the line is half the job: the other half is landing the eye on it
 * inside a scrollback of four megabytes. So the row does two things — it
 * takes the workspace to that terminal (`navigate.goToTerminalId`, which also
 * turns the group to the surface the terminal lives on), and it opens that
 * pane's find bar with the line already typed in, so xterm scrolls to the
 * match and highlights it.
 *
 * The two frames of delay are the whole subtlety here. `goToTerminalId` only
 * writes to the stores; the pane that will answer `yard:find` is the one that
 * *becomes* focused, and its listener is attached on the render that follows.
 * Dispatching in the same tick reaches the pane that was focused before —
 * that is, the wrong terminal, or none at all.
 *
 * Effects only: the rules (who is asked first, what a row says) are pure in
 * `outputSearch.ts`, next to their tests.
 */
import { goToTerminalId } from "./navigate";
import type { OutputRow } from "./outputSearch";

export function openOutputHit(row: OutputRow) {
  goToTerminalId(row.terminalId);
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.dispatchEvent(
        new CustomEvent("yard:find", { detail: { query: row.match } }),
      ),
    ),
  );
}
