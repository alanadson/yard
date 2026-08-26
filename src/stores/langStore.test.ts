/**
 * The interface's language has two owners — the preference in the UI store
 * and, under "system", the OS — and one consumer that must never see two
 * answers: `lib/i18n.ts`'s active language. `startLanguage` is the only
 * writer of that value and of `<html lang>`; it has to follow both owners
 * and stop cleanly, or a hot reload leaves two subscriptions fighting.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activeLang, setActiveLang } from "../lib/i18n";
import { resolvedLang, startLanguage, useLangStore } from "./langStore";
import { DEFAULT_PREFS, useUI } from "./uiStore";

beforeEach(() => {
  useUI.setState({ prefs: { ...DEFAULT_PREFS } });
  useLangStore.setState({ navigatorLanguage: undefined });
});

afterEach(() => setActiveLang("pt-BR"));

describe("resolvedLang", () => {
  it("is Portuguese out of the box, whatever the OS speaks", () => {
    useLangStore.setState({ navigatorLanguage: "en-US" });
    expect(resolvedLang()).toBe("pt-BR");
  });

  it("system follows the OS once the user asks for it", () => {
    useUI.setState({ prefs: { ...DEFAULT_PREFS, lang: "system" } });
    useLangStore.setState({ navigatorLanguage: "en-GB" });
    expect(resolvedLang()).toBe("en");
    useLangStore.setState({ navigatorLanguage: "pt-BR" });
    expect(resolvedLang()).toBe("pt-BR");
  });
});

describe("startLanguage", () => {
  it("writes the active language and <html lang> at once, and again when the preference changes", () => {
    const root = { lang: "" };
    const stop = startLanguage(root, "en-US");
    expect(activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");
    useUI.getState().setPrefLocal("lang", "en");
    expect(activeLang()).toBe("en");
    expect(root.lang).toBe("en");
    stop();
  });

  it("under system, remembers what the OS said when it started", () => {
    const root = { lang: "" };
    useUI.setState({ prefs: { ...DEFAULT_PREFS, lang: "system" } });
    const stop = startLanguage(root, "en");
    expect(activeLang()).toBe("en");
    stop();
  });

  it("stops following the preference once stopped", () => {
    const root = { lang: "" };
    const stop = startLanguage(root, undefined);
    stop();
    useUI.getState().setPrefLocal("lang", "en");
    expect(activeLang()).toBe("pt-BR");
    expect(root.lang).toBe("pt-BR");
  });

  it("survives a missing document root (tests, a headless webview)", () => {
    const stop = startLanguage(null, "en-US");
    useUI.getState().setPrefLocal("lang", "en");
    expect(activeLang()).toBe("en");
    stop();
  });
});
