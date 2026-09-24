/**
 * When the exit strip says "waiting for free memory", and the number it says.
 *
 * Kept apart from the strip because it is what the strip *subscribes* to:
 * every mounted terminal renders an `ExitBanner`, and subscribing each one to
 * the raw free memory (moved by the resources tick every two seconds)
 * re-rendered all of them on every tick to paint nothing. This answer is
 * constant outside the one state that paints it, and inside it moves only
 * when the printed number does.
 */
import type { TerminalRow } from "../../lib/ipc";
import type { TerminalRuntime } from "../../stores/terminalsStore";

/**
 * Free RAM the backend demands before spawning an agent (`SPAWN_MIN_FREE_MB`
 * in `pty/mod.rs`). It waits up to 45 s for it, silently, with the card stuck
 * on "Iniciando" without saying why. The front end already receives the free
 * memory in the resources tick, so the same truth can be told without
 * inventing a new event: below this mark, a spawn that takes long is waiting
 * for RAM.
 */
export const SPAWN_MIN_FREE_MB = 400;

/**
 * The free memory to print, rounded to the MB the strip shows, while an agent
 * is starting below the mark; `null` in every other state. `0` free is "no
 * tick yet", not an empty machine, and says nothing.
 */
export function memoryWaitMb(
  rt: Pick<TerminalRuntime, "state"> | null | undefined,
  term: Pick<TerminalRow, "kind"> | undefined,
  freeMb: number,
): number | null {
  if (rt?.state !== "starting" || term?.kind !== "agent") return null;
  if (!(freeMb > 0 && freeMb < SPAWN_MIN_FREE_MB)) return null;
  return Math.round(freeMb);
}
