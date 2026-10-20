import { ipc } from "./ipc";
import { runBackground } from "./background";
import type { NativeQueueResult, QueueItem } from "./queue";

export type PrefsSnapshot = Record<string, string>;

export interface PrefsTransport {
  nativeScheduler?: boolean;
  readPrefs: () => Promise<PrefsSnapshot>;
  writePref: (key: string, value: string) => Promise<void>;
  writePrefs?: (entries: [string, string][]) => Promise<void>;
  patchQueue?: (before: readonly QueueItem[], after: readonly QueueItem[]) => Promise<QueueItem[]>;
  retryQueue?: (id: string, newId: string, attemptedAt: number) => Promise<QueueItem[]>;
  removeQueue?: (id: string, attemptedAt?: number) => Promise<QueueItem[]>;
  dispatchQueue?: (id: string, terminalId: string, attemptedAt: number) => Promise<NativeQueueResult>;
  readQueue?: () => Promise<QueueItem[]>;
}

const tauriTransport: PrefsTransport = {
  nativeScheduler: true,
  readPrefs: () => ipc.readPrefs(),
  writePref: (key, value) => ipc.writePref(key, value),
  writePrefs: (entries) => ipc.writePrefs(entries),
  patchQueue: (before, after) => ipc.queuePatch(before, after),
  retryQueue: (id, newId, attemptedAt) => ipc.queueRetry(id, newId, attemptedAt),
  removeQueue: (id, attemptedAt) => ipc.queueRemove(id, attemptedAt),
  dispatchQueue: (id, terminalId, attemptedAt) => ipc.queueDispatch(id, terminalId, attemptedAt),
  readQueue: () => ipc.queueRead(),
};

let transport = tauriTransport;
let initialRead: Promise<Record<string, string>> | null = null;
export function nativeQueueScheduling(): boolean { return transport.nativeScheduler === true; }

export function dispatchQueuedItem(id: string, terminalId: string, attemptedAt: number): Promise<NativeQueueResult> | null {
  return transport.dispatchQueue?.(id, terminalId, attemptedAt) ?? null;
}

export function readNativeQueue(): Promise<QueueItem[]> | null { return transport.readQueue?.() ?? null; }

/** Native queue edits preserve concurrent entries; older adapters keep their existing contract. */
export async function writeQueue(before: readonly QueueItem[], after: readonly QueueItem[]): Promise<QueueItem[]> {
  if (transport.patchQueue) return transport.patchQueue(before, after);
  await transport.writePref("queue.items", JSON.stringify(after));
  return [...after];
}

export async function retryQueuedItem(before: readonly QueueItem[], id: string, newId: string, attemptedAt: number): Promise<QueueItem[]> {
  if (transport.retryQueue) return transport.retryQueue(id, newId, attemptedAt);
  const after = before.map((item) => {
    if (item.id !== id) return item;
    const { delivery: _delivery, ...request } = item;
    return { ...request, id: newId };
  });
  return writeQueue(before, after);
}

export async function removeQueuedItem(before: readonly QueueItem[], id: string, attemptedAt?: number): Promise<QueueItem[]> {
  if (transport.removeQueue) return transport.removeQueue(id, attemptedAt);
  return writeQueue(before, before.filter((item) => item.id !== id));
}

/** Awaited atomic batches on the native transport, with adapter compatibility. */
export async function writePrefs(entries: [string, string][]): Promise<void> {
  if (transport.writePrefs) return transport.writePrefs(entries);
  for (const [key, value] of entries) await transport.writePref(key, value);
}

/** Shares the boot-time KV read between every store hydrated by `App.boot`. */
export function readInitialPrefs(): Promise<PrefsSnapshot> {
  if (!initialRead) {
    initialRead = transport.readPrefs().catch((error) => {
      initialRead = null;
      throw error;
    });
  }
  return initialRead;
}

/** A fresh read for explicit reloads; bootstrap callers should pass a snapshot. */
export function readPrefs(): Promise<PrefsSnapshot> {
  return transport.readPrefs();
}

/**
 * Fire-and-forget preference write used by UI state stores.
 *
 * `invoke` throws synchronously outside Tauri (Vitest/jsdom). That condition
 * is intentionally inert; an asynchronous rejection is a real persistence
 * failure and is sent to the caller's logger.
 */
export function persistPref(
  key: string,
  value: string,
  onError?: (error: unknown) => void,
): void {
  runBackground(() => transport.writePref(key, value), { error: onError });
}

export function persistJsonPref(
  key: string,
  value: unknown,
  onError?: (error: unknown) => void,
): void {
  persistPref(key, JSON.stringify(value), onError);
}

/** Test seam for stores: restores the previous adapter when disposed. */
export function setPrefsTransport(next: PrefsTransport): () => void {
  const previous = transport;
  transport = next;
  initialRead = null;
  return () => {
    transport = previous;
    initialRead = null;
  };
}
