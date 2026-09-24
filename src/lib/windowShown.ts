/**
 * Is the main window on screen at all?
 *
 * The backend emits `window://shown` whenever the window is hidden or
 * minimized (`false`) and when it comes back (`true`). Anything that polls on
 * a timer (a phone's screenshot feed, a portal's reload probe) reads it here
 * to stop working for a window nobody can see, and to catch up once when it
 * returns.
 *
 * The default is "shown": a backend that never reports keeps the old
 * behaviour. The store itself is plain data and listeners, testable without
 * Tauri; the event is only wired in when the first subscriber arrives.
 */
import { useSyncExternalStore } from "react";

import { on } from "./ipc";

export type ShownListener = (shown: boolean) => void;

export interface ShownStore {
  get(): boolean;
  /** Records a report; listeners hear it only when the state actually moved. */
  set(shown: boolean): void;
  subscribe(listener: ShownListener): () => void;
}

export function createShownStore(initial = true): ShownStore {
  let shown = initial;
  const listeners = new Set<ShownListener>();
  return {
    get: () => shown,
    set(next) {
      if (next === shown) return;
      shown = next;
      for (const listener of [...listeners]) listener(shown);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const store = createShownStore();
/** The event subscription, taken once for the life of the page. */
let wired: Promise<unknown> | null = null;

function wire(): void {
  if (wired) return;
  wired = on
    .windowShown((payload) => store.set(payload.shown))
    .catch(() => {
      // No backend (a test, a plain browser): stay "shown" and let a later
      // subscriber try again.
      wired = null;
    });
}

export function isWindowShown(): boolean {
  return store.get();
}

export function subscribeWindowShown(listener: ShownListener): () => void {
  wire();
  return store.subscribe(listener);
}

/** The window state as React state: re-renders only when it changes. */
export function useWindowShown(): boolean {
  return useSyncExternalStore(subscribeWindowShown, isWindowShown);
}
