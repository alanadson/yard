/**
 * What is waiting to be typed into each terminal (`lib/queue.ts` holds the
 * rules; `hooks/useQueue.ts` does the typing).
 *
 * Persisted in the kv, unlike the broadcast: a queued prompt is work the user
 * has already stopped holding in their head, and this app reloads on HMR, on
 * F5 and after a restored backup while the PTYs carry on in Rust. Coming back
 * with an empty queue would silently drop three tasks.
 *
 * `take` exists as one operation for one reason: two effects (a runtime tick
 * and a store subscription) can look at the same head item in the same frame,
 * and a queue that hands the same prompt to two senders types it twice.
 */
import { create } from "zustand";
import { nanoid } from "nanoid";

import { persistPref, type PrefsSnapshot } from "../lib/prefs";
import {
  appended,
  countFor,
  moved,
  parseQueue,
  pendingFor,
  pruned,
  withoutId,
  withoutTerminal,
  type QueueItem,
  type QueueSource,
} from "../lib/queue";

export const KV_QUEUE = "queue.items";

const persist = (items: QueueItem[]) =>
  persistPref(KV_QUEUE, JSON.stringify(items), (error) =>
    console.warn(`[yard] não consegui gravar ${KV_QUEUE}`, error),
  );

export interface EnqueueResult {
  ok: boolean;
  /** 1-based place in that terminal's queue, when it went in. */
  position?: number;
  /** Why not, when it did not. */
  reason?: "vazio" | "cheia";
}

interface QueueState {
  items: QueueItem[];
  enqueue: (
    terminalId: string,
    text: string,
    source: QueueSource,
    by?: string,
  ) => EnqueueResult;
  /** Removes and returns the head item of a terminal, or `null`. */
  take: (terminalId: string) => QueueItem | null;
  cancel: (id: string) => void;
  clear: (terminalId: string) => void;
  move: (id: string, delta: -1 | 1) => void;
  prune: (exists: (terminalId: string) => boolean) => void;
  count: (terminalId: string) => number;
  listFor: (terminalId: string) => QueueItem[];
  hydrate: (prefs: PrefsSnapshot) => void;
}

export const useQueue = create<QueueState>((set, get) => ({
  items: [],

  enqueue: (terminalId, text, source, by) => {
    const body = text.trim();
    // An empty prompt is a bare Enter typed into a CLI — which, on an agent
    // sitting at a confirmation, answers it.
    if (!body) return { ok: false, reason: "vazio" };
    const item: QueueItem = {
      id: nanoid(),
      terminalId,
      text: body,
      at: Date.now(),
      source,
      ...(by ? { by } : {}),
    };
    const { items, full } = appended(get().items, item);
    if (full) return { ok: false, reason: "cheia" };
    set({ items });
    persist(items);
    return { ok: true, position: countFor(items, terminalId) };
  },

  take: (terminalId) => {
    const head = pendingFor(get().items, terminalId)[0];
    if (!head) return null;
    const items = withoutId(get().items, head.id);
    set({ items });
    persist(items);
    return head;
  },

  cancel: (id) => {
    const items = withoutId(get().items, id);
    set({ items });
    persist(items);
  },

  clear: (terminalId) => {
    const items = withoutTerminal(get().items, terminalId);
    set({ items });
    persist(items);
  },

  move: (id, delta) => {
    const items = moved(get().items, id, delta);
    set({ items });
    persist(items);
  },

  prune: (exists) => {
    const items = pruned(get().items, exists);
    if (items.length === get().items.length) return;
    set({ items });
    persist(items);
  },

  count: (terminalId) => countFor(get().items, terminalId),

  listFor: (terminalId) => pendingFor(get().items, terminalId),

  hydrate: (prefs) => set({ items: parseQueue(prefs[KV_QUEUE]) }),
}));
