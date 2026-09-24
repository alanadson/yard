/**
 * What the pane grid subscribes to.
 *
 * The grid paints one group, and it used to subscribe to the whole `groups`
 * and `terminals` arrays to find it. Both are rewritten by writes that have
 * nothing to do with the group on screen: a board's viewport commit, an agent
 * writing to a board note through `yard`, a tab switch on another floor, a
 * CLI renamed elsewhere. Each one re-rendered every pane here (they are not
 * memoized) and every xterm inside them. These answers only change when this
 * group's own data does.
 */
import type { GroupRow, TerminalRow } from "../../lib/ipc";
import { sameItems, stableSelect } from "../../lib/stableSelect";

/**
 * The group's layout, as the string the store keeps. A string compares by
 * value, so a write to another group leaves it equal and Zustand skips the
 * render; `parseLayout` caches by the same string, so the parsed layout keeps
 * its identity too. A group that is not there reads as `""`, which the
 * parser turns into the default layout, as it always did.
 */
export function layoutJsonOf(groups: readonly GroupRow[], groupId: string): string {
  return groups.find((g) => g.id === groupId)?.layoutJson ?? "";
}

/**
 * The group's CLIs, in the store's order, as one array that keeps its
 * identity while none of them was rewritten. The store replaces a row object
 * only when that row changes, so "the same objects in the same order" is
 * exactly "nothing here changed". One selector per mounted grid: it remembers
 * its last answer.
 */
export function groupTerminalsSelector(
  groupId: string,
): (s: { terminals: readonly TerminalRow[] }) => TerminalRow[] {
  return stableSelect(
    (s: { terminals: readonly TerminalRow[] }) => s.terminals.filter((t) => t.groupId === groupId),
    sameItems,
  );
}
