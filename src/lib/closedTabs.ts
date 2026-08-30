/**
 * The tab you did not mean to close.
 *
 * Drafts already survive a reload, so closing a tab by accident never cost
 * the text. What it cost was the *place*: which pane it was in, which
 * comparison it was showing, where in a tree of four thousand files you had
 * found it. That is what this stack holds, which is why an entry describes a
 * tab rather than naming a path.
 */
import type { DiffSpec } from "./diffTab";

export interface ClosedTab {
  projectId: string | null;
  groupId: string | null;
  slot: number;
  root: string;
  path: string;
  /** Set when the tab was a comparison, so it comes back as that comparison. */
  diff?: DiffSpec;
}

/** Past this it is not "the one I just closed" any more. */
export const CLOSED_CAP = 20;

/** A comparison and the file it compares are two different tabs. */
function sameTab(a: ClosedTab, b: ClosedTab): boolean {
  return (
    a.root === b.root &&
    a.path === b.path &&
    JSON.stringify(a.diff ?? null) === JSON.stringify(b.diff ?? null)
  );
}

/**
 * Remembers a closed tab, on top. Opening and closing the same file over and
 * over must not fill the stack with one file, so an entry that is already
 * there moves rather than repeats.
 */
export function push(stack: readonly ClosedTab[], tab: ClosedTab): ClosedTab[] {
  const without = stack.filter((t) => !sameTab(t, tab));
  return [...without, tab].slice(-CLOSED_CAP);
}

/** The most recently closed tab, and the stack without it. */
export function pop(
  stack: readonly ClosedTab[],
): { tab: ClosedTab; rest: ClosedTab[] } | null {
  if (stack.length === 0) return null;
  return { tab: stack[stack.length - 1], rest: stack.slice(0, -1) };
}

/**
 * Drops every entry the predicate takes. Used when a group or a project
 * leaves the workspace: reopening into a pane that is gone is a tab with
 * nowhere to go, and the store would have to invent a home for it.
 */
export function forget(
  stack: readonly ClosedTab[],
  gone: (tab: ClosedTab) => boolean,
): ClosedTab[] {
  const left = stack.filter((t) => !gone(t));
  return left.length === stack.length ? (stack as ClosedTab[]) : left;
}
