/**
 * The resolved appearance — one value, two owners.
 *
 * The preference (`prefs.theme` in the UI store) says what the user wants;
 * the OS says what "system" means right now. Everything that paints its own
 * pixels and cannot read a CSS token — the terminal well, the code editor's
 * palette — asks this store, and `startTheme` is the single place that
 * writes the answer onto `<html>`.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import { applyTheme, resolveTheme, type ResolvedTheme, type ThemeRoot } from "../lib/theme";
import { useUI } from "./uiStore";

interface ThemeState {
  /** What `prefers-color-scheme: dark` says; `true` until anyone asks the OS. */
  systemDark: boolean;
  setSystemDark: (dark: boolean) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  systemDark: true,
  setSystemDark: (systemDark) => set({ systemDark }),
}));

/** The appearance on screen, from the preference and the OS. */
export function resolvedTheme(): ResolvedTheme {
  return resolveTheme(useUI.getState().prefs.theme, useThemeStore.getState().systemDark);
}

function subscribeResolved(cb: () => void): () => void {
  const a = useUI.subscribe(cb);
  const b = useThemeStore.subscribe(cb);
  return () => {
    a();
    b();
  };
}

/** The resolved appearance, as a React subscription — re-renders only when it flips. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeResolved, resolvedTheme, resolvedTheme);
}

/** The slice of `MediaQueryList` the store listens to. */
export interface SystemQuery {
  readonly matches: boolean;
  addEventListener(type: "change", cb: () => void): void;
  removeEventListener(type: "change", cb: () => void): void;
}

/**
 * Wires the OS query and the preference to `<html>`. Applies at once, on
 * every change of either owner, and undoes both subscriptions when stopped —
 * a hot reload that left the old listener behind would repaint twice. With
 * no query at all (tests, a webview without `matchMedia`) "system" means
 * dark: the shipped look, never a crash.
 */
export function startTheme(root: ThemeRoot, query: SystemQuery | null): () => void {
  const store = useThemeStore.getState();
  store.setSystemDark(query ? query.matches : true);
  const paint = () => applyTheme(root, resolvedTheme());
  const onSystem = () => useThemeStore.getState().setSystemDark(query ? query.matches : true);
  query?.addEventListener("change", onSystem);
  const unsubscribe = subscribeResolved(paint);
  paint();
  return () => {
    query?.removeEventListener("change", onSystem);
    unsubscribe();
  };
}
