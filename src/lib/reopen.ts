/**
 * The undo for a closed tab (`Ctrl+Shift+T`).
 *
 * Yard's tab bar holds three kinds of thing — CLIs, files and browsers — and
 * only two of them belong in here. Closing a **CLI** is `Excluir CLI`: a
 * confirmed, destructive action that ends a process, and a stack that
 * "reopened" it would be offering to respawn something, which is a different
 * promise entirely. Closing a **file** or a **browser** is Ctrl+W, one key
 * away from Ctrl+E, and costs nothing but the path — which is exactly what
 * makes it worth remembering.
 *
 * Deliberately in memory: the stack is about the last few minutes. A file
 * closed yesterday is found through the Busca, not through an undo.
 */

/** How many closings are worth keeping. Past this it is not an undo any more. */
export const REOPEN_CAP = 20;

interface Base {
  /** Identity of the tab: closing the same one twice must not stack twice. */
  key: string;
  groupId: string | null;
  slot: number;
  closedAt: number;
}

export interface ClosedDoc extends Base {
  kind: "doc";
  root: string;
  /** Relative to the root, with `/`. */
  path: string;
}

export interface ClosedBrowser extends Base {
  kind: "browser";
  url: string;
}

export type ClosedTab = ClosedDoc | ClosedBrowser;

/** Newest last. */
export function pushClosed(
  stack: readonly ClosedTab[],
  tab: ClosedTab,
): ClosedTab[] {
  const without = stack.filter((t) => t.key !== tab.key);
  const next = [...without, tab];
  return next.length > REOPEN_CAP ? next.slice(next.length - REOPEN_CAP) : next;
}

export function popClosed(stack: readonly ClosedTab[]): {
  tab: ClosedTab | null;
  rest: ClosedTab[];
} {
  if (stack.length === 0) return { tab: null, rest: [] };
  return { tab: stack[stack.length - 1], rest: stack.slice(0, -1) };
}
