/**
 * The interface's language.
 *
 * The product is written in Brazilian Portuguese, and the Portuguese text is
 * the key: `t("Salvar")` is "Salvar" in pt-BR and, in English, whatever the
 * dictionary says for that exact sentence — or the Portuguese again when
 * nobody wrote the English line yet, recorded once so the gap reaches the
 * log instead of the screen. No invented ids: the source stays readable,
 * and the tests that assert on UI text keep asserting the Portuguese.
 *
 * Two shapes of caller:
 *
 * - libs, stores, toasts, menu builders call `t()`/`tn()` here — they read
 *   the active language at call time;
 * - components call `useT()` (`hooks/useT.ts`), which is the same `t` plus
 *   the subscription that re-renders them when the language flips.
 *
 * Module-level tables (shortcuts, settings categories, palette rows) keep
 * their Portuguese and are translated where they are *rendered*, never
 * restructured. `stores/langStore.ts` owns the preference + OS resolution and
 * is the only writer of the active language.
 *
 * The English lines are a lazy chunk, not an import: about 224 kB, 17% of the
 * startup chunk, parsed on every boot for a language most boots never speak.
 * `loadEnglish` fetches them the first time English is resolved, and
 * `setActiveLang` refuses English until they are here, so `t()` stays
 * synchronous and never answers in Portuguese while English is active.
 */
import { uiLog } from "./log";

export type Lang = "pt-BR" | "en";
export type LangPref = Lang | "system";

export const LANG_PREFS: readonly LangPref[] = ["pt-BR", "en", "system"];

export function isLangPref(value: unknown): value is LangPref {
  return typeof value === "string" && (LANG_PREFS as readonly string[]).includes(value);
}

/**
 * "system" is English only for an English OS: this app was born in
 * Portuguese, and any other language of the machine gets the original.
 */
export function resolveLang(pref: LangPref, navigatorLanguage: string | undefined): Lang {
  if (pref !== "system") return pref;
  return /^en(?:[-_]|$)/i.test((navigatorLanguage ?? "").trim()) ? "en" : "pt-BR";
}

export type Vars = Record<string, string | number>;

/** `{name}` placeholders; one with no value stays as written, visibly. */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

export type Dictionary = Readonly<Record<string, string>>;

const missing = new Set<string>();

/** The keys asked for in English with no English line — for tests and dev. */
export function missingKeys(): readonly string[] {
  return [...missing];
}

function noteMissing(text: string): void {
  if (missing.has(text)) return;
  missing.add(text);
  if (import.meta.env.DEV) {
    try {
      uiLog.warn(`i18n: sem linha em inglês para "${text}"`);
    } catch {
      /* no backend: the set already remembers it */
    }
  }
}

export function translate(dict: Dictionary, lang: Lang, text: string, vars?: Vars): string {
  if (lang === "pt-BR") return interpolate(text, vars);
  const line = dict[text];
  if (line === undefined) noteMissing(text);
  return interpolate(line ?? text, vars);
}

// ---------------------------------------------------------------------------
// the English dictionary: a chunk of its own, fetched on demand
// ---------------------------------------------------------------------------

/** How the dictionary arrives: the chunk import, or a stand-in in a test. */
export type EnglishLoader = () => Promise<{ default: Dictionary }>;

const importEnglish: EnglishLoader = () => import("../i18n/en");

let english: Dictionary | null = null;
let fetching: Promise<void> | null = null;

/**
 * Hands the dictionary over: the loader's last step, and the whole of the
 * test suite's setup, which registers it before every file so a test can
 * switch to English synchronously, as it always could.
 */
export function registerEnglish(dict: Dictionary): void {
  english = dict;
}

/** Whether English can be made active right now, with no fetch. */
export function englishLoaded(): boolean {
  return english !== null;
}

/**
 * Fetches the English lines, once. Everyone who asks while the chunk is on
 * its way waits on the same fetch; one that failed is forgotten, so the next
 * ask tries again instead of inheriting the rejection forever.
 */
export function loadEnglish(load: EnglishLoader = importEnglish): Promise<void> {
  if (english) return Promise.resolve();
  fetching ??= load().then(
    (chunk) => registerEnglish(chunk.default),
    (error: unknown) => {
      fetching = null;
      throw error;
    },
  );
  return fetching;
}

// ---------------------------------------------------------------------------
// the active language — written by stores/langStore.ts
// ---------------------------------------------------------------------------

let active: Lang = "pt-BR";

const listeners = new Set<() => void>();

/**
 * Makes `lang` the language `t()` speaks, and tells the subscribers
 * (`useT()`) when it actually changed. English without its dictionary is
 * refused: every `t()` would come back in Portuguese under an English
 * `<html lang>`, and each sentence would be logged as a missing line.
 */
export function setActiveLang(lang: Lang): void {
  if (lang === "en" && !english) {
    throw new Error("i18n: the English dictionary is not loaded yet; await loadEnglish() first");
  }
  if (lang === active) return;
  active = lang;
  for (const listener of [...listeners]) listener();
}

export function activeLang(): Lang {
  return active;
}

/** Called after every flip of the active language; returns the unsubscribe. */
export function subscribeActiveLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const NO_LINES: Dictionary = Object.freeze({});

/** The sentence in the active language. Portuguese in, Portuguese or English out. */
export function t(text: string, vars?: Vars): string {
  return translate(english ?? NO_LINES, active, text, vars);
}

/**
 * Plural by count, both forms in Portuguese as keys; `{n}` is filled on its
 * own. English lines translate each form separately.
 */
export function tn(count: number, singular: string, plural: string, vars?: Vars): string {
  return t(count === 1 ? singular : plural, { n: count, ...vars });
}

/** For `toLocaleDateString` and friends — never a hard-coded "pt-BR" again. */
export function locale(): "pt-BR" | "en-US" {
  return active === "en" ? "en-US" : "pt-BR";
}

// ---------------------------------------------------------------------------
// the language the last session showed, for the next boot
// ---------------------------------------------------------------------------

/** The halves of `localStorage` the memory needs: injectable, for the test. */
export interface LangMemory {
  setItem(key: string, value: string): void;
}

export interface LangRecall {
  getItem(key: string): string | null;
}

/** Where the resolved language waits for the next boot. */
export const LANG_MEMORY_KEY = "yard.lang";

/**
 * Leaves the language on screen where the next boot can read it
 * synchronously. The preference lives in SQLite, an `await` away, and the
 * English lines are a fetch away: with no mirror, an English user would watch
 * the boot in Portuguese every launch. Storage can be refused (a locked-down
 * webview, a private profile) and that is not worth a broken window, so the
 * write never escapes. Reading the global is inside the `try` on purpose: a
 * webview with storage switched off throws on the property itself.
 */
export function rememberLang(lang: Lang, memory?: LangMemory | null): void {
  try {
    const store = memory === undefined ? globalThis.localStorage : memory;
    store?.setItem(LANG_MEMORY_KEY, lang);
  } catch {
    // The next boot starts in Portuguese and corrects itself; no harm done.
  }
}

/** The language the last session showed, or `null` (first run, refused, unknown). */
export function recallLang(memory?: LangRecall | null): Lang | null {
  try {
    const store = memory === undefined ? globalThis.localStorage : memory;
    const remembered = store ? store.getItem(LANG_MEMORY_KEY) : null;
    return remembered === "en" || remembered === "pt-BR" ? remembered : null;
  } catch {
    return null;
  }
}
