/**
 * The interface's language — one value, two owners.
 *
 * The preference (`prefs.lang` in the UI store) says what the user wants;
 * the OS says what "system" means. `lib/i18n.ts` must see a single answer,
 * so `startLanguage` is the only writer of its active language and of
 * `<html lang>`: it applies at once, again on every change of either owner,
 * and undoes its subscription when stopped. Components that render `t()`
 * subscribe to the active language through `hooks/useT.ts`, so a flip
 * re-renders them; libs and stores just call `t()`, which reads the value
 * written here.
 *
 * English costs a fetch the first time (`lib/i18n.loadEnglish`, a chunk of
 * its own). The switch waits for the dictionary and only then writes the
 * active language, `<html lang>` and the memory for the next boot, together:
 * nothing is ever half English, and `t()` answers in the previous language
 * while the lines are on their way. `restoreLanguage` is the boot's half: the
 * language the last session showed, put back before the first render and
 * held in place of the preference until `App` has read it from SQLite
 * (`releaseRememberedLang`), because the defaults read before that say
 * Portuguese.
 */
import { create } from "zustand";

import {
  englishLoaded,
  loadEnglish,
  recallLang,
  rememberLang,
  resolveLang,
  setActiveLang,
  type EnglishLoader,
  type Lang,
  type LangMemory,
  type LangRecall,
} from "../lib/i18n";
import { uiLog } from "../lib/log";
import { useUI } from "./uiStore";

interface LangState {
  /** `navigator.language` as seen when the app started; `undefined` = unknown. */
  navigatorLanguage: string | undefined;
  setNavigatorLanguage: (value: string | undefined) => void;
  /**
   * The language the boot restored from memory, standing in for the
   * preference until `App` has read it; `null` = follow the preference.
   */
  remembered: Lang | null;
}

export const useLangStore = create<LangState>((set) => ({
  navigatorLanguage: undefined,
  setNavigatorLanguage: (navigatorLanguage) => set({ navigatorLanguage }),
  remembered: null,
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

/** The slice of `document.documentElement` the store writes. */
export interface LangRoot {
  lang: string;
}

/** What the tests swap; the app passes nothing and gets the real ones. */
export interface LanguageOptions {
  /** Where the language on screen is left for the next boot; default `localStorage`. */
  memory?: LangMemory | null;
  /** How the English lines arrive; default the dictionary chunk. */
  load?: EnglishLoader;
}

function warnNoEnglish(error: unknown): void {
  uiLog.warn(`não consegui carregar o dicionário em inglês: ${error}`);
}

/**
 * Wires the preference and the OS answer to `lib/i18n.ts` and to `<html>`.
 * `navigatorLanguage` is read once: an OS language does not change under a
 * running app, and asking `navigator` on every store change would be noise.
 *
 * A switch to English that has to fetch its lines lands only if it is still
 * the answer when they arrive: a flip back to Portuguese in the meantime, or
 * a stop (a hot reload), wins over the late dictionary. A fetch that fails
 * leaves Portuguese on screen and logs; picking English again tries again.
 */
export function startLanguage(
  root: LangRoot | null,
  navigatorLanguage: string | undefined,
  options: LanguageOptions = {},
): () => void {
  useLangStore.getState().setNavigatorLanguage(navigatorLanguage);
  let last: Lang | null = null;
  let stopped = false;
  const show = (lang: Lang) => {
    setActiveLang(lang);
    if (root) root.lang = lang;
    rememberLang(lang, options.memory);
  };
  const apply = () => {
    const lang = useLangStore.getState().remembered ?? resolvedLang();
    if (lang === last) return;
    last = lang;
    if (lang === "en" && !englishLoaded()) {
      loadEnglish(options.load).then(() => {
        if (!stopped && last === lang) show(lang);
      }, warnNoEnglish);
      return;
    }
    show(lang);
  };
  const unsubscribe = subscribeResolved(apply);
  apply();
  return () => {
    stopped = true;
    unsubscribe();
  };
}

/** The boot's options: the memory is only read here. */
export interface RestoreOptions {
  memory?: LangRecall | null;
  load?: EnglishLoader;
}

/**
 * Before the first render (`main.tsx`): puts back the language the last
 * session showed. Portuguese, or nothing remembered, needs nothing: `null`,
 * and the boot renders at once, exactly as it always did. English waits for
 * its dictionary, becomes the active language and `<html lang>`, and holds in
 * place of the preference until `releaseRememberedLang`. The promise never
 * rejects: a dictionary that fails to arrive opens the window in Portuguese,
 * because a window in the wrong language beats no window.
 */
export function restoreLanguage(root: LangRoot | null, options: RestoreOptions = {}): Promise<void> | null {
  if (recallLang(options.memory) !== "en") return null;
  return loadEnglish(options.load).then(() => {
    setActiveLang("en");
    if (root) root.lang = "en";
    useLangStore.setState({ remembered: "en" });
  }, warnNoEnglish);
}

/**
 * `App` has read the preferences from SQLite: the remembered language stops
 * standing in for them, and the real answer (the same one, almost always)
 * takes over. Idempotent, so a retried boot can call it again.
 */
export function releaseRememberedLang(): void {
  if (useLangStore.getState().remembered !== null) useLangStore.setState({ remembered: null });
}
