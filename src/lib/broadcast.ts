/**
 * Keyboard broadcast — one terminal's keystrokes typed into every other live
 * CLI of the same group.
 *
 * The mode exists for the moments a team of agents all wait on the same
 * answer: the `y` after a fan-out, a `/clear` before the next task, a short
 * instruction to five recruits. It is **session-only** on purpose — a
 * broadcast that came back on at boot would type into terminals nobody was
 * looking at (`stores/broadcastStore.ts` keeps it in memory, never in `kv`).
 *
 * This module is the pure half: who receives. The effect (the extra
 * `write_pty` per target) lives in `XTermView`'s `onData`.
 */
import { t, tn } from "./i18n";
import type { TerminalRow } from "./ipc";
import { isLive, type TerminalRuntime } from "../stores/terminalsStore";

/**
 * Every OTHER terminal of the group with a live process — tabs and canvas
 * cards alike. The source is never in the list (it already received the
 * keystroke), a terminal with no runtime is treated as dead, and nothing
 * outside the group is ever reached.
 */
export function broadcastTargets(
  rows: readonly TerminalRow[],
  runtimes: Record<string, TerminalRuntime | undefined>,
  sourceId: string,
  groupId: string,
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.groupId !== groupId || row.id === sourceId) continue;
    if (!isLive(runtimes[row.id])) continue;
    out.push(row.id);
  }
  return out;
}

/** The key that turns the mode off, spelled the way the strip and the toast say it. */
export const BROADCAST_KEY = "Ctrl+Shift+U";

function clis(count: number): string {
  return tn(count, "{n} CLI", "{n} CLIs");
}

/**
 * The strip drawn over every terminal of the armed group. It has to count,
 * and it has to say when the count is zero: a group whose other agents all
 * exited would otherwise look armed for no reason.
 */
export function broadcastLabel(count: number): string {
  if (count === 0) {
    return t("⇶ Transmitindo — nenhuma outra CLI viva no grupo · {key} desliga", { key: BROADCAST_KEY });
  }
  return t("⇶ Transmitindo para {clis} · {key} desliga", { clis: clis(count), key: BROADCAST_KEY });
}

/** The toast after a toggle: what just happened, and to how many. */
export function toggleMessage(on: boolean, count: number): string {
  if (!on) return t("Transmissão desligada.");
  if (count === 0) {
    return t("Transmissão ligada — nenhuma outra CLI viva no grupo por enquanto.");
  }
  return t("Transmitindo o teclado para {clis} do grupo.", { clis: clis(count) });
}
