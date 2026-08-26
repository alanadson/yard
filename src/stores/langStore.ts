/**
 * The interface's language — one value, two owners.
 *
 * The preference (`prefs.lang` in the UI store) says what the user wants;
 * the OS says what "system" means. `lib/i18n.ts` must see a single answer,
 * so `startLanguage` is the only writer of its active language and of
 * `<html lang>`: it applies at once, again on every change of either owner,
 * and undoes its subscription when stopped. Components that render `t()`
 * subscribe through `useResolvedLang` (via `hooks/useT.ts`) so a flip
 * re-renders them; libs and stores just call `t()`, which reads the value
 * written here.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import { resolveLang, setActiveLang, type Lang } from "../lib/i18n";
import { useUI } from "./uiStore";

interface LangState {
  /** `navigator.language` as seen when the app started; `undefined` = unknown. */
  navigatorLanguage: string | undefined;
  setNavigatorLanguage: (value: string | undefined) => void;
}

export const useLangStore = create<LangState>((set) => ({
  navigatorLanguage: undefined,
  setNavigatorLanguage: (navigatorLanguage) => set({ navigatorLanguage }),
}));

/** The language on screen, from the preference and the OS. */
export function resolvedLang(): Lang {
  return resolveLang(useUI.getState().prefs.lang, useLangStore.getState().navigatorLanguage);
}

function subscribeResolved(cb: () => void): () => void {
  const a = useUI.subscribe(cb);
  const b = useLangStore.subscribe(cb);
  return () => {
    a();
    b();
  };
}

/** The resolved language, as a React subscription — re-renders only when it flips. */
export function useResolvedLang(): Lang {
  return useSyncExternalStore(subscribeResolved, resolvedLang, resolvedLang);
}

/** The slice of `document.documentElement` the store writes. */
export interface LangRoot {
  lang: string;
}

/**
 * Wires the preference and the OS answer to `lib/i18n.ts` and to `<html>`.
 * `navigatorLanguage` is read once: an OS language does not change under a
 * running app, and asking `navigator` on every store change would be noise.
 */
export function startLanguage(root: LangRoot | null, navigatorLanguage: string | undefined): () => void {
  useLangStore.getState().setNavigatorLanguage(navigatorLanguage);
  let last: Lang | null = null;
  const apply = () => {
    const lang = resolvedLang();
    if (lang === last) return;
    last = lang;
    setActiveLang(lang);
    if (root) root.lang = lang;
  };
  const unsubscribe = subscribeResolved(apply);
  apply();
  return unsubscribe;
}
