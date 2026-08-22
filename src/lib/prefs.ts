import { ipc } from "./ipc";
import { runBackground } from "./background";

export type PrefsSnapshot = Record<string, string>;

export interface PrefsTransport {
  readPrefs: () => Promise<PrefsSnapshot>;
  writePref: (key: string, value: string) => Promise<void>;
}

const tauriTransport: PrefsTransport = {
  readPrefs: () => ipc.readPrefs(),
  writePref: (key, value) => ipc.writePref(key, value),
};

let transport = tauriTransport;
let initialRead: Promise<Record<string, string>> | null = null;

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
