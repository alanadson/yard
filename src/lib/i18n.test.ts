/**
 * The product speaks Brazilian Portuguese by default, and the PT-BR text IS
 * the key: `t("Salvar")` returns "Salvar" until the user (or the OS, under
 * "system") asks for English, and then the English line of the dictionary —
 * or, when nobody wrote that line yet, the Portuguese again, recorded once
 * so the gap shows up in the log instead of as a blank on screen. Tests that
 * assert on UI text never change because of this module.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  activeLang,
  interpolate,
  isLangPref,
  locale,
  missingKeys,
  resolveLang,
  setActiveLang,
  t,
  tn,
  translate,
} from "./i18n";

afterEach(() => setActiveLang("pt-BR"));

describe("resolveLang", () => {
  it("an explicit choice wins over whatever the OS says", () => {
    expect(resolveLang("pt-BR", "en-US")).toBe("pt-BR");
    expect(resolveLang("en", "pt-BR")).toBe("en");
  });

  it("system means English only for an English OS — anything else, or no answer, is Portuguese", () => {
    expect(resolveLang("system", "en-US")).toBe("en");
    expect(resolveLang("system", "en")).toBe("en");
    expect(resolveLang("system", "pt-BR")).toBe("pt-BR");
    expect(resolveLang("system", "es-ES")).toBe("pt-BR");
    expect(resolveLang("system", undefined)).toBe("pt-BR");
  });

  it("sifts a preference read from the kv", () => {
    expect(isLangPref("en")).toBe(true);
    expect(isLangPref("system")).toBe(true);
    expect(isLangPref("fr")).toBe(false);
    expect(isLangPref(undefined)).toBe(false);
  });
});

describe("interpolate", () => {
  it("fills {name} placeholders and leaves the ones it has no value for", () => {
    expect(interpolate("Olá, {name} — {n} arquivos", { name: "Ana", n: 3 })).toBe(
      "Olá, Ana — 3 arquivos",
    );
    expect(interpolate("Falta {x}", {})).toBe("Falta {x}");
    expect(interpolate("Sem variáveis")).toBe("Sem variáveis");
  });
});

describe("translate", () => {
  const dict = { Salvar: "Save", "{n} arquivos": "{n} files" };

  it("returns the Portuguese text itself in pt-BR, with the variables filled", () => {
    expect(translate(dict, "pt-BR", "Salvar")).toBe("Salvar");
    expect(translate(dict, "pt-BR", "{n} arquivos", { n: 2 })).toBe("2 arquivos");
  });

  it("returns the English line in en, with the variables filled", () => {
    expect(translate(dict, "en", "Salvar")).toBe("Save");
    expect(translate(dict, "en", "{n} arquivos", { n: 2 })).toBe("2 files");
  });

  it("falls back to the Portuguese when the English line is missing, and records the gap once", () => {
    expect(translate(dict, "en", "Texto sem tradução ainda")).toBe("Texto sem tradução ainda");
    translate(dict, "en", "Texto sem tradução ainda");
    expect(missingKeys().filter((k) => k === "Texto sem tradução ainda")).toHaveLength(1);
  });
});

describe("t / tn / locale — bound to the active language", () => {
  it("is Portuguese until someone switches, and reads the shipped dictionary in English", () => {
    expect(activeLang()).toBe("pt-BR");
    expect(t("Aparência")).toBe("Aparência");
    setActiveLang("en");
    expect(t("Aparência")).toBe("Appearance");
  });

  it("tn picks the singular for exactly one and fills {n} on its own", () => {
    expect(tn(1, "{n} arquivo", "{n} arquivos")).toBe("1 arquivo");
    expect(tn(0, "{n} arquivo", "{n} arquivos")).toBe("0 arquivos");
    expect(tn(5, "{n} arquivo", "{n} arquivos")).toBe("5 arquivos");
  });

  it("locale follows the active language, for toLocale* calls", () => {
    expect(locale()).toBe("pt-BR");
    setActiveLang("en");
    expect(locale()).toBe("en-US");
  });
});
