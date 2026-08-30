/**
 * The Busca's fifth source: what the terminals **said**.
 *
 * `Ctrl+P` finds a terminal by its name; xterm's own search walks the one
 * terminal that is mounted. Neither answers "where did I see that error?",
 * which is the question a workspace with six agents produces all day. The
 * `$` prefix asks the backend (`scrollback_search.rs`) instead, and this file
 * is the part with rules: who is asked first, whether the sweep is worth
 * doing, and how a raw line becomes a row.
 *
 * It is a scoped search on purpose — never part of the unprefixed hunt. The
 * unprefixed list is built from memory in a `useMemo`; this one reads
 * megabytes off the disk per keystroke, and paying that for someone typing
 * "novo terminal" would be the wrong trade.
 */
import type { TerminalHits } from "./ipc";

/** Below this, the sweep costs more than it can possibly be worth. */
export const MIN_QUERY = 2;

/** How many lines come back per terminal, and in total. */
export const PER_TERMINAL = 4;
export const TOTAL_HITS = 40;

export function worthSearching(text: string): boolean {
  return text.trim().length >= MIN_QUERY;
}

interface TerminalLike {
  id: string;
  groupId: string;
}

/**
 * The order the terminals are asked in. It is also the order of the answer
 * (the backend preserves it) and the order the rows appear in, which is why
 * it is a rule and not an implementation detail: the total budget runs out
 * somewhere down this list, and whatever is past that point is never read.
 */
export function searchOrder(
  terminals: readonly TerminalLike[],
  activeGroupId: string | null,
  focusedTerminalId: string | null,
): string[] {
  const out: string[] = [];
  const push = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  if (focusedTerminalId && terminals.some((t) => t.id === focusedTerminalId)) {
    push(focusedTerminalId);
  }
  if (activeGroupId) {
    for (const t of terminals) if (t.groupId === activeGroupId) push(t.id);
  }
  for (const t of terminals) push(t.id);
  return out;
}

export interface OutputRow {
  /** Unique per hit: two lines of the same terminal are two rows. */
  id: string;
  terminalId: string;
  line: number;
  /** What the row shows. */
  title: string;
  /** The terminal's name (its id, when the row is gone from the workspace). */
  name: string;
  /** The text to hand xterm's search once the terminal is on screen. */
  match: string;
}

/**
 * Turns the backend's answer into rows. `nameOf` is the workspace's memory of
 * what that terminal is called — a hit can come from a terminal whose row was
 * renamed, or whose pane was closed hours ago.
 */
export function hitRows(
  answer: readonly TerminalHits[],
  nameOf: (terminalId: string) => string | undefined,
): OutputRow[] {
  const rows: OutputRow[] = [];
  for (const terminal of answer) {
    const name = nameOf(terminal.terminalId) || terminal.terminalId;
    for (const hit of terminal.hits) {
      const trimmed = hit.text.trim();
      rows.push({
        id: `${terminal.terminalId}:${hit.line}:${hit.col}`,
        terminalId: terminal.terminalId,
        line: hit.line,
        title: hit.clipped ? `…${trimmed}…` : trimmed,
        name,
        match: trimmed,
      });
    }
  }
  return rows;
}
