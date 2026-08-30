/**
 * A work queue per terminal — the app finally able to *feed* the agents, not
 * just watch them.
 *
 * Everything needed for this already existed and none of it was connected.
 * `sendable.ts` knows when a CLI can take a prompt; `inject.ts` knows how to
 * type one in; the composer, the bench and the diff review all knew how to
 * refuse when the agent was busy. Refusing is the right answer for a person
 * who is right there and can retry. It is the wrong answer for the actual
 * workflow: you have the next three things this agent should do, it is
 * mid-answer, and holding them in your head until it goes quiet is the work
 * the app should be doing.
 *
 * So: the prompt is parked, and the first moment the CLI is genuinely ready
 * (process up, not blocked on a permission prompt, quiet for `IDLE_MS`) the
 * head of its queue is typed in.
 *
 * The rules, and why each one is here:
 *
 * - **one item per terminal per opening.** Draining the whole queue the
 *   moment a CLI goes quiet pastes N prompts into one line; the second item
 *   waits for the *next* opening.
 * - **FIFO, per terminal.** Two agents' queues never interleave — `moved`
 *   reorders an item among its own terminal's items and leaves everyone
 *   else's order untouched.
 * - **a cap per terminal.** An agent looping on `yard ask --queue` must not
 *   fill the workspace's queue; it fills its own and is told so.
 */

/** Items one terminal may have waiting. Past this the answer is "no". */
export const QUEUE_CAP = 20;

/** Where a queued prompt came from — the card shows it, the CLI reports it. */
export type QueueSource = "user" | "bridge" | "bench" | "review";

export interface QueueItem {
  id: string;
  terminalId: string;
  text: string;
  /** When it was queued (ms). Ordering is by position, not by this. */
  at: number;
  source: QueueSource;
  /** Who queued it, when that is another agent. Shown on the card. */
  by?: string;
}

export function pendingFor(
  items: readonly QueueItem[],
  terminalId: string,
): QueueItem[] {
  return items.filter((i) => i.terminalId === terminalId);
}

export function countFor(items: readonly QueueItem[], terminalId: string): number {
  return pendingFor(items, terminalId).length;
}

export function appended(
  items: readonly QueueItem[],
  item: QueueItem,
): { items: QueueItem[]; full: boolean } {
  if (countFor(items, item.terminalId) >= QUEUE_CAP) {
    return { items: [...items], full: true };
  }
  return { items: [...items, item], full: false };
}

export function withoutId(items: readonly QueueItem[], id: string): QueueItem[] {
  return items.filter((i) => i.id !== id);
}

export function withoutTerminal(
  items: readonly QueueItem[],
  terminalId: string,
): QueueItem[] {
  return items.filter((i) => i.terminalId !== terminalId);
}

/**
 * Moves an item one place among **its terminal's** items. The list itself is
 * flat and shared, so the swap happens between the two positions that hold
 * those two items — which is why this is not a plain index arithmetic.
 */
export function moved(
  items: readonly QueueItem[],
  id: string,
  delta: -1 | 1,
): QueueItem[] {
  const target = items.find((i) => i.id === id);
  if (!target) return [...items];
  const mine = pendingFor(items, target.terminalId);
  const at = mine.findIndex((i) => i.id === id);
  const to = at + delta;
  if (to < 0 || to >= mine.length) return [...items];

  const a = items.indexOf(target);
  const b = items.indexOf(mine[to]);
  const out = [...items];
  out[a] = mine[to];
  out[b] = target;
  return out;
}

/**
 * The head item of every terminal that is ready to take it — at most one per
 * terminal, in the order the terminals appear in the queue.
 */
export function dueItems(
  items: readonly QueueItem[],
  isReady: (terminalId: string) => boolean,
): QueueItem[] {
  const seen = new Set<string>();
  const out: QueueItem[] = [];
  for (const item of items) {
    if (seen.has(item.terminalId)) continue;
    seen.add(item.terminalId);
    if (isReady(item.terminalId)) out.push(item);
  }
  return out;
}

/** Drops whatever is queued for terminals that no longer exist. */
export function pruned(
  items: readonly QueueItem[],
  exists: (terminalId: string) => boolean,
): QueueItem[] {
  return items.filter((i) => exists(i.terminalId));
}

/** kv gives back text, and the format on disk is never to be trusted. */
export function parseQueue(raw: string | undefined): QueueItem[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
      .filter(
        (i) =>
          typeof i.id === "string" &&
          typeof i.terminalId === "string" &&
          typeof i.text === "string" &&
          i.text.length > 0,
      )
      .map((i) => ({
        id: i.id as string,
        terminalId: i.terminalId as string,
        text: i.text as string,
        at: typeof i.at === "number" ? i.at : 0,
        source: (["user", "bridge", "bench", "review"] as const).includes(
          i.source as QueueSource,
        )
          ? (i.source as QueueSource)
          : "user",
        ...(typeof i.by === "string" ? { by: i.by as string } : {}),
      }));
  } catch {
    return [];
  }
}
