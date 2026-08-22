import { on, type PortalMenu } from "./ipc";

type MenuListener = (event: PortalMenu) => void;

const menuListeners = new Map<string, Set<MenuListener>>();
let menuUnlisten: (() => void) | null = null;
let menuStart: Promise<void> | null = null;
let menuGeneration = 0;

function listenerCount(): number {
  let count = 0;
  for (const listeners of menuListeners.values()) count += listeners.size;
  return count;
}

function ensureMenuListener(): void {
  if (menuUnlisten || menuStart || listenerCount() === 0) return;
  const generation = ++menuGeneration;
  menuStart = on
    .portalMenu((event) => {
      for (const listener of menuListeners.get(event.id) ?? []) listener(event);
    })
    .then((unlisten) => {
      if (generation !== menuGeneration || listenerCount() === 0) unlisten();
      else menuUnlisten = unlisten;
    })
    .finally(() => {
      if (generation === menuGeneration) menuStart = null;
    });
}

function stopMenuListenerIfIdle(): void {
  if (listenerCount() > 0) return;
  menuGeneration += 1;
  menuUnlisten?.();
  menuUnlisten = null;
  menuStart = null;
}

/** Multiplexes the global Tauri topic into one listener set per portal id. */
export function watchPortalMenu(id: string, listener: MenuListener): () => void {
  const listeners = menuListeners.get(id) ?? new Set<MenuListener>();
  listeners.add(listener);
  menuListeners.set(id, listeners);
  ensureMenuListener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) menuListeners.delete(id);
    stopMenuListenerIfIdle();
  };
}
