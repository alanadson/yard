/**
 * Pinned tabs and the preview tab.
 *
 * Browsing a tree of four thousand files used to cost one tab per file
 * glanced at, and the file actually being worked on drifted off the left edge
 * of the bar. The two rules here are opposites of each other: a **preview**
 * tab is the one the next glance replaces, and a **pinned** tab is the one
 * nothing replaces or closes by accident.
 *
 * They meet in the "close the others" commands, which is where the damage
 * would be. A pin that does not survive "fechar as outras" is not a pin.
 */

export interface TabInfo {
  id: string;
  groupId: string | null;
  slot: number;
  pinned: boolean;
  /** Opened by a single click, and replaced by the next single click. */
  preview: boolean;
  /** Holds text nobody has written to disk. */
  dirty: boolean;
}

/** Which tabs a close command takes. */
export type CloseScope = "others" | "right" | "saved";

/** Same bar: the same pane of the same group. */
function samePane<T extends { groupId: string | null; slot: number }>(a: T, b: T): boolean {
  return a.groupId === b.groupId && a.slot === b.slot;
}

/**
 * Pinned tabs to the front of each bar, order preserved inside each half. The
 * bar is per pane, so a pin in one pane never jumps a tab in another.
 */
export function orderTabs<T extends TabInfo>(docs: readonly T[]): T[] {
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
 * The preview tab a newly opened file should take the place of, in the pane
 * it is opening into.
 *
 * A preview holding unsaved text is not replaced: the tab is still a preview,
 * but it is carrying work now, and the whole gesture is supposed to be free.
 */
export function previewToReplace<T extends TabInfo>(
  docs: readonly T[],
  groupId: string | null,
  slot: number,
): string | null {
  const found = docs.find(
    (d) => d.groupId === groupId && d.slot === slot && d.preview && !d.pinned && !d.dirty,
  );
  return found?.id ?? null;
}
