/**
 * The English dictionary is about 224 kB of the interface, and Portuguese is
 * the default: most boots never read a line of it. So it is a lazy chunk,
 * fetched the first time English is resolved, and one promise makes that
 * safe: English is never *active* without its lines. An active "en" with no
 * dictionary behind it would have every `t()` answer in Portuguese while
 * `<html lang>` says English, and log every sentence of the app as missing.
 *
 * Each test takes a fresh copy of the module (`vi.resetModules`). The suite's
 * setup (`i18nTestSetup.ts`) hands every file the dictionary up front, so the
 * synchronous `setActiveLang("en")` the older tests rely on keeps working; a
 * fresh copy is the only way to see a boot that has not fetched it yet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Dictionary } from "./i18n";

type I18n = typeof import("./i18n");
let i18n: I18n;

beforeEach(async () => {
  vi.resetModules();
  i18n = await import("./i18n");
});

/** The chunk fetch, held open until the test answers it. */
function heldLoader() {
  const pending: Array<{
    resolve: (chunk: { default: Dictionary }) => void;
    reject: (error: unknown) => void;
  }> = [];
  const load = () =>
    new Promise<{ default: Dictionary }>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return { load, pending };
}

const LINES: Dictionary = { Aparência: "Appearance", "{n} arquivos": "{n} files" };

describe("the English dictionary, fetched on demand", () => {
  it("refuses English before the dictionary arrived, and keeps speaking Portuguese", () => {
    expect(() => i18n.setActiveLang("en")).toThrow(/English dictionary/);
    expect(i18n.activeLang()).toBe("pt-BR");
    expect(i18n.t("Aparência")).toBe("Aparência");
  });

  it("once loaded, English answers synchronously with the same contract as before", async () => {
    const { load, pending } = heldLoader();
    const loading = i18n.loadEnglish(load);
    pending[0].resolve({ default: LINES });
    await loading;

    i18n.setActiveLang("en");
    expect(i18n.t("Aparência")).toBe("Appearance");
    expect(i18n.tn(3, "{n} arquivo", "{n} arquivos")).toBe("3 files");
    expect(i18n.locale()).toBe("en-US");
  });

  it("fetches the chunk once, however many ask while it is on its way", async () => {
    const { load, pending } = heldLoader();
    const first = i18n.loadEnglish(load);
    const second = i18n.loadEnglish(load);
    expect(pending).toHaveLength(1);
    pending[0].resolve({ default: LINES });
    await Promise.all([first, second]);
    await i18n.loadEnglish(load);
    expect(pending).toHaveLength(1);
  });

  it("a fetch that failed can be tried again", async () => {
    const { load, pending } = heldLoader();
    const failed = i18n.loadEnglish(load);
    pending[0].reject(new Error("chunk missing"));
    await expect(failed).rejects.toThrow("chunk missing");
    expect(() => i18n.setActiveLang("en")).toThrow();

    const retry = i18n.loadEnglish(load);
    pending[1].resolve({ default: LINES });
    await retry;
    i18n.setActiveLang("en");
    expect(i18n.t("Aparência")).toBe("Appearance");
  });

  it("the default loader brings the shipped dictionary", async () => {
    await i18n.loadEnglish();
    i18n.setActiveLang("en");
    expect(i18n.t("Aparência")).toBe("Appearance");
  });
});

describe("subscribeActiveLang", () => {
  it("tells subscribers when the active language flips, and only then", async () => {
    const { load, pending } = heldLoader();
    const loading = i18n.loadEnglish(load);
    pending[0].resolve({ default: LINES });
    await loading;
    const seen: string[] = [];
    const stop = i18n.subscribeActiveLang(() => seen.push(i18n.activeLang()));

    i18n.setActiveLang("pt-BR");
    expect(seen).toEqual([]);
    i18n.setActiveLang("en");
    i18n.setActiveLang("en");
    expect(seen).toEqual(["en"]);
    stop();
    i18n.setActiveLang("pt-BR");
    expect(seen).toEqual(["en"]);
  });
});

/** A `localStorage` stand-in: the two methods the memory needs. */
function memoryOf(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("the remembered language", () => {
  it("keeps what was resolved for the next boot, both languages", () => {
    const memory = memoryOf();
    i18n.rememberLang("en", memory);
    expect(memory.data.get(i18n.LANG_MEMORY_KEY)).toBe("en");
    expect(i18n.recallLang(memory)).toBe("en");
    i18n.rememberLang("pt-BR", memory);
    expect(i18n.recallLang(memory)).toBe("pt-BR");
  });

  it("recalls nothing on a first run or from a value it does not know", () => {
    expect(i18n.recallLang(memoryOf())).toBeNull();
    expect(i18n.recallLang(memoryOf({ [i18n.LANG_MEMORY_KEY]: "fr" }))).toBeNull();
    expect(i18n.recallLang(null)).toBeNull();
  });

  it("storage that refuses (a locked-down webview) is not worth a broken window", () => {
    const refusing = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => i18n.rememberLang("en", refusing)).not.toThrow();
    expect(i18n.recallLang(refusing)).toBeNull();
  });
});
