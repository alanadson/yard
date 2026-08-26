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
 */
import EN from "../i18n/en";
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
// the active language — written by stores/langStore.ts
// ---------------------------------------------------------------------------

let active: Lang = "pt-BR";

export function setActiveLang(lang: Lang): void {
  active = lang;
}

export function activeLang(): Lang {
  return active;
}

/** The sentence in the active language. Portuguese in, Portuguese or English out. */
export function t(text: string, vars?: Vars): string {
  return translate(EN, active, text, vars);
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
