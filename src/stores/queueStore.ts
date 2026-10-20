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

import { removeQueuedItem, retryQueuedItem, writeQueue, type PrefsSnapshot } from "../lib/prefs";
import { runBackground } from "../lib/background";
import { mergeQueueAcknowledgement } from "../lib/queuePatch";
import { reasonOf } from "../lib/loading";
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

const persist = (before: QueueItem[], after: QueueItem[]) => runBackground(() => writeQueue(before, after), {
  success: (acknowledged) => useQueue.setState((state) => ({ items: mergeQueueAcknowledgement(state.items, before, after, acknowledged) })),
  error: (error) => useQueue.setState({ error: reasonOf(error) }),
});

export interface EnqueueResult {
  ok: boolean;
  /** 1-based place in that terminal's queue, when it went in. */
  position?: number;
  /** Why not, when it did not. */
  reason?: "vazio" | "cheia" | "failed";
}

interface QueueState {
  items: QueueItem[];
  error: string | null;
  enqueue: (
    terminalId: string,
    text: string,
    source: QueueSource,
    by?: string,
  ) => Promise<EnqueueResult>;
  /** Removes and returns the head item of a terminal, or `null`. */
  take: (terminalId: string) => QueueItem | null;
  retry: (id: string, newId?: string) => Promise<boolean>;
  cancel: (id: string) => Promise<boolean>;
  clear: (terminalId: string) => void;
  move: (id: string, delta: -1 | 1) => void;
  prune: (exists: (terminalId: string) => boolean) => void;
  count: (terminalId: string) => number;
  listFor: (terminalId: string) => QueueItem[];
  hydrate: (prefs: PrefsSnapshot) => void;
}

export const useQueue = create<QueueState>((set, get) => ({
  items: [],
  error: null,

  enqueue: async (terminalId, text, source, by) => {
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
    const before = get().items;
    const { items, full } = appended(before, item);
    if (full) return { ok: false, reason: "cheia" };
    set({ error: null });
    try {
      const acknowledged = await writeQueue(before, items);
      if (!acknowledged.some((row) => row.id === item.id)) throw new Error("QUEUE_NOT_ACKNOWLEDGED");
      const current = get().items;
      const visible = current.some((row) => row.id === item.id) ? current : [...current, item];
      set({ items: mergeQueueAcknowledgement(visible, before, items, acknowledged) });
      return { ok: true, position: countFor(acknowledged, terminalId) };
    } catch (error) {
      const message = reasonOf(error);
      set({ error: message });
      return { ok: false, reason: message.includes("QUEUE_FULL") ? "cheia" : "failed" };
    }
  },

  take: (terminalId) => {
    const before = get().items;
    const head = pendingFor(get().items, terminalId)[0];
    if (!head) return null;
    const items = withoutId(get().items, head.id);
    set({ items });
    persist(before, items);
    return head;
  },

  cancel: async (id) => {
    const before = get().items;
    const item = before.find((item) => item.id === id);
    if (!item) return true;
    try {
      const reviewedAt = item.delivery?.status === "uncertain" ? item.delivery.attemptedAt : undefined;
      const acknowledged = await removeQueuedItem(before, id, reviewedAt);
      const after = withoutId(before, id);
      set((state) => ({ items: mergeQueueAcknowledgement(state.items, before, after, acknowledged), error: null }));
      return true;
    } catch (error) { set({ error: reasonOf(error) }); return false; }
  },

  retry: async (id, newId = nanoid()) => {
    const before = get().items;
    const original = before.find((item) => item.id === id);
    if (original?.delivery?.status !== "uncertain" || original.taskId) return false;
    try {
      const acknowledged = await retryQueuedItem(before, id, newId, original.delivery.attemptedAt);
      const fresh = acknowledged.find((item) => item.id === newId);
      if (!fresh) throw new Error("QUEUE_NOT_ACKNOWLEDGED");
      const after = before.map((item) => item.id === id ? fresh : item);
      const current = get().items;
      const visible = current.some((item) => item.id === fresh.id) ? current : [...current, fresh];
      set({ items: mergeQueueAcknowledgement(visible, before, after, acknowledged), error: null });
      return true;
    } catch (error) { set({ error: reasonOf(error) }); return false; }
  },

  clear: (terminalId) => {
    const before = get().items;
    const items = withoutTerminal(get().items, terminalId);
    set({ items });
    persist(before, items);
  },

  move: (id, delta) => {
    const before = get().items;
    const items = moved(get().items, id, delta);
    set({ items });
    persist(before, items);
  },

  prune: (exists) => {
    const before = get().items;
    const items = pruned(get().items, exists);
    if (items.length === get().items.length) return;
    set({ items });
    persist(before, items);
  },

  count: (terminalId) => countFor(get().items, terminalId),

  listFor: (terminalId) => pendingFor(get().items, terminalId),

  hydrate: (prefs) => set({ items: parseQueue(prefs[KV_QUEUE]) }),
}));
