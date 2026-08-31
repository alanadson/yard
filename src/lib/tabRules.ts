/**
 * Pinned tabs, and what a close command takes.
 *
 * Opening a file never takes another tab's place: the bar is a record of what
 * the user opened, and only the user closes something. What is left to rule
 * on is the pin, a tab nothing closes by accident, kept at the front of its
 * own bar.
 *
 * That meets the "close the others" commands, which is where the damage would
 * be. A pin that does not survive "fechar as outras" is not a pin.
 */

/**
 * Where a tab sits in the grid, and whether it holds the front of its bar.
 * Ordering needs nothing else, which is what lets one rule serve the three
 * kinds of tab: the CLI row from the workspace, the open file, the browser.
 */
export interface TabPlace {
  id: string;
  groupId: string | null;
  slot: number;
  /** Absent reads as loose: a row written before pins existed. */
  pinned?: boolean;
}

export interface TabInfo extends TabPlace {
  pinned: boolean;
  /** Holds text nobody has written to disk. */
  dirty: boolean;
}

/** Which tabs a close command takes. */
export type CloseScope = "others" | "right" | "saved";

/** Same bar: the same pane of the same group. */
function samePane(
  a: { groupId: string | null; slot: number },
  b: { groupId: string | null; slot: number },
): boolean {
  return a.groupId === b.groupId && a.slot === b.slot;
}

/**
 * Pinned tabs to the front of each bar, order preserved inside each half. The
 * bar is per pane, so a pin in one pane never jumps a tab in another.
 */
export function orderTabs<T extends TabPlace>(docs: readonly T[]): T[] {
  const seen: { groupId: string | null; slot: number }[] = [];
  const out: T[] = [];
  for (const doc of docs) {
    if (seen.some((pane) => samePane(pane, doc))) continue;
    seen.push({ groupId: doc.groupId, slot: doc.slot });
    const bar = docs.filter((d) => samePane(d, doc));
    out.push(...bar.filter((d) => d.pinned), ...bar.filter((d) => !d.pinned));
  }
  return out;
}

/**
 * The ids a close command would take, inside the target's own pane.
 *
 * A pinned tab is never in the answer. "saved" is the one command whose whole
 * point is to leave unwritten work alone, so it keeps the dirty ones and,
 * unlike the other two, may well include the target itself.
 */
export function closesWith<T extends TabInfo>(
  docs: readonly T[],
  targetId: string,
  scope: CloseScope,
): string[] {
  const target = docs.find((d) => d.id === targetId);
  if (!target) return [];
  const bar = docs.filter((d) => samePane(d, target));
  const at = bar.findIndex((d) => d.id === targetId);

  return bar
    .filter((d, i) => {
      if (d.pinned) return false;
      if (scope === "saved") return !d.dirty;
      if (d.id === targetId) return false;
      return scope === "others" || i > at;
    })
    .map((d) => d.id);
}

/**
 * Where a tab lands after walking one place toward `dir` in its own bar.
 *
 * The answer speaks the language every store's move already takes: a
 * `beforeId` to be put in front of, or `null` for the end of the bar. `null`
 * as the whole answer means the tab is not going anywhere, which is what the
 * menu greys out.
 *
 * It reads the bar through `orderTabs`, because that is what is on screen: a
 * command computed over the store's raw list would send the tab somewhere the
 * user did not point at. And it refuses to trade a pinned tab for a loose one:
 * that move would be undone by the next render, and a command that pretends
 * to work is worse than one that says no.
 */
export function moveOnePlace<T extends TabPlace>(
  tabs: readonly T[],
  id: string,
  dir: -1 | 1,
): { beforeId: string | null } | null {
  const target = tabs.find((t) => t.id === id);
  if (!target) return null;
  const bar = orderTabs(tabs).filter((t) => samePane(t, target));
  const at = bar.findIndex((t) => t.id === id);
  const neighbor = bar[at + dir];
  if (at < 0 || !neighbor || !!neighbor.pinned !== !!target.pinned) return null;
  // Leftward the tab takes the neighbour's place; rightward it has to clear
  // the neighbour first, which means landing in front of whatever came after
  // it, and nothing there is the end of the bar.
  return { beforeId: dir === -1 ? neighbor.id : (bar[at + 2]?.id ?? null) };
}
