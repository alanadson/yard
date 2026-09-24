/**
 * The English dictionary is a lazy chunk (`lib/i18n.ts`), so resolving
 * English is no longer one synchronous write: the lines have to arrive
 * first. Two things must survive that. Nobody may see English half-applied,
 * a `<html lang="en">` over Portuguese text, or a component re-rendered for
 * English that still reads Portuguese. And an English user must not pay for
 * the laziness with Portuguese on screen at boot: the language the last
 * session resolved is remembered, the boot waits for its dictionary before
 * the first render, and that language stands in for the preference until
 * SQLite answers (the defaults, read before that, would say Portuguese).
 *
 * Fresh modules per test: the suite's setup hands every file the dictionary
 * up front, and only a fresh `lib/i18n` shows a boot that has not fetched it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Dictionary } from "../lib/i18n";

type I18n = typeof import("../lib/i18n");
type LangStore = typeof import("./langStore");
type UIStore = typeof import("./uiStore");
let i18n: I18n;
let lang: LangStore;
let ui: UIStore;

beforeEach(async () => {
  vi.resetModules();
  i18n = await import("../lib/i18n");
  lang = await import("./langStore");
  ui = await import("./uiStore");
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

/** A `localStorage` stand-in: the two methods the memory needs. */
function memoryOf(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

/** Lets the settled chunk promise run its callbacks. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const LINES: Dictionary = { Aparência: "Appearance" };

describe("switching to English before its dictionary was fetched", () => {
  it("fetches the dictionary first, then makes English active for t(), <html lang> and the subscribers at once", async () => {
    const root = { lang: "" };
    const { load, pending } = heldLoader();
    const flips: string[] = [];
    i18n.subscribeActiveLang(() => flips.push(i18n.activeLang()));
    const stop = lang.startLanguage(root, undefined, { load, memory: null });

    ui.useUI.getState().setPrefLocal("lang", "en");
    expect(pending).toHaveLength(1);
    expect(i18n.activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");
    expect(flips).toEqual([]);

    pending[0].resolve({ default: LINES });
    await settle();
    expect(i18n.activeLang()).toBe("en");
    expect(root.lang).toBe("en");
    expect(flips).toEqual(["en"]);
    expect(i18n.t("Aparência")).toBe("Appearance");
    stop();
  });

  it("t() keeps answering in the previous language while the dictionary is on its way", async () => {
    const { load, pending } = heldLoader();
    const stop = lang.startLanguage(null, undefined, { load, memory: null });

    ui.useUI.getState().setPrefLocal("lang", "en");
    expect(i18n.t("Aparência")).toBe("Aparência");
    // Portuguese on purpose, not a gap: nothing may be logged as missing.
    expect(i18n.missingKeys()).toEqual([]);

    pending[0].resolve({ default: LINES });
    await settle();
    expect(i18n.t("Aparência")).toBe("Appearance");
    stop();
  });

  it("going back to Portuguese before the dictionary lands wins over the late arrival", async () => {
    const root = { lang: "" };
    const { load, pending } = heldLoader();
    const stop = lang.startLanguage(root, undefined, { load, memory: null });

    ui.useUI.getState().setPrefLocal("lang", "en");
    ui.useUI.getState().setPrefLocal("lang", "pt-BR");
    pending[0].resolve({ default: LINES });
    await settle();
    expect(i18n.activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");

    // Already fetched: the next switch is as synchronous as it always was.
    ui.useUI.getState().setPrefLocal("lang", "en");
    expect(i18n.activeLang()).toBe("en");
    expect(pending).toHaveLength(1);
    stop();
  });

  it("stopped while the dictionary is on its way, it writes nothing when it lands", async () => {
    const root = { lang: "" };
    const { load, pending } = heldLoader();
    const stop = lang.startLanguage(root, undefined, { load, memory: null });

    ui.useUI.getState().setPrefLocal("lang", "en");
    stop();
    pending[0].resolve({ default: LINES });
    await settle();
    expect(i18n.activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");
  });

  it("a dictionary that fails to arrive leaves Portuguese on screen, and picking English again tries again", async () => {
    const root = { lang: "" };
    const { load, pending } = heldLoader();
    const stop = lang.startLanguage(root, undefined, { load, memory: null });

    ui.useUI.getState().setPrefLocal("lang", "en");
    pending[0].reject(new Error("chunk missing"));
    await settle();
    expect(i18n.activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");

    ui.useUI.getState().setPrefLocal("lang", "pt-BR");
    ui.useUI.getState().setPrefLocal("lang", "en");
    expect(pending).toHaveLength(2);
    pending[1].resolve({ default: LINES });
    await settle();
    expect(i18n.activeLang()).toBe("en");
    stop();
  });

  it("remembers what it put on screen, for the next boot", async () => {
    const memory = memoryOf();
    const { load, pending } = heldLoader();
    const stop = lang.startLanguage(null, undefined, { load, memory });
    expect(memory.data.get(i18n.LANG_MEMORY_KEY)).toBe("pt-BR");

    ui.useUI.getState().setPrefLocal("lang", "en");
    // Not before it is true: a crash mid-fetch must not boot the next
    // session into a language it never showed.
    expect(memory.data.get(i18n.LANG_MEMORY_KEY)).toBe("pt-BR");
    pending[0].resolve({ default: LINES });
    await settle();
    expect(memory.data.get(i18n.LANG_MEMORY_KEY)).toBe("en");
    stop();
  });
});

describe("the boot, from the language the last session resolved", () => {
  it("with English remembered, the dictionary and English are in place before the first render", async () => {
    const root = { lang: "pt-BR" };
    const { load, pending } = heldLoader();
    const ready = lang.restoreLanguage(root, {
      memory: memoryOf({ [i18n.LANG_MEMORY_KEY]: "en" }),
      load,
    });

    expect(ready).not.toBeNull();
    pending[0].resolve({ default: LINES });
    await ready;
    expect(i18n.t("Aparência")).toBe("Appearance");
    expect(i18n.activeLang()).toBe("en");
    expect(root.lang).toBe("en");
  });

  it("the remembered English stands in for the preference until it is read: the defaults never flash Portuguese", async () => {
    const root = { lang: "pt-BR" };
    const memory = memoryOf({ [i18n.LANG_MEMORY_KEY]: "en" });
    const { load, pending } = heldLoader();
    const ready = lang.restoreLanguage(root, { memory, load });
    pending[0].resolve({ default: LINES });
    await ready;
    const flips: string[] = [];
    i18n.subscribeActiveLang(() => flips.push(i18n.activeLang()));

    // `App` mounts with the preferences still at their defaults (pt-BR).
    const stop = lang.startLanguage(root, undefined, { load, memory });
    expect(i18n.activeLang()).toBe("en");
    await ui.useUI.getState().loadPrefs({ lang: "en" });
    lang.releaseRememberedLang();

    expect(i18n.activeLang()).toBe("en");
    expect(root.lang).toBe("en");
    expect(flips).toEqual([]);
    stop();
  });

  it("once the preference is read, it wins over a memory that disagrees", async () => {
    const root = { lang: "pt-BR" };
    const memory = memoryOf({ [i18n.LANG_MEMORY_KEY]: "en" });
    const { load, pending } = heldLoader();
    const ready = lang.restoreLanguage(root, { memory, load });
    pending[0].resolve({ default: LINES });
    await ready;
    const stop = lang.startLanguage(root, undefined, { load, memory });

    await ui.useUI.getState().loadPrefs({});
    expect(i18n.activeLang()).toBe("en");
    lang.releaseRememberedLang();

    expect(i18n.activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");
    expect(memory.data.get(i18n.LANG_MEMORY_KEY)).toBe("pt-BR");
    stop();
  });

  it("with Portuguese or nothing remembered, there is nothing to wait for and nothing is fetched", () => {
    const root = { lang: "pt-BR" };
    const { load, pending } = heldLoader();

    expect(lang.restoreLanguage(root, { memory: memoryOf({ [i18n.LANG_MEMORY_KEY]: "pt-BR" }), load })).toBeNull();
    expect(lang.restoreLanguage(root, { memory: memoryOf(), load })).toBeNull();
    expect(lang.restoreLanguage(root, { memory: null, load })).toBeNull();
    expect(pending).toHaveLength(0);
    expect(i18n.activeLang()).toBe("pt-BR");
  });

  it("a dictionary that fails to load at boot opens the window in Portuguese instead of never opening it", async () => {
    const root = { lang: "pt-BR" };
    const { load, pending } = heldLoader();
    const ready = lang.restoreLanguage(root, {
      memory: memoryOf({ [i18n.LANG_MEMORY_KEY]: "en" }),
      load,
    });

    pending[0].reject(new Error("chunk missing"));
    await expect(ready).resolves.toBeUndefined();
    expect(i18n.activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");
  });
});
