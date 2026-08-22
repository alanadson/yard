/**
 * The Busca's two structural rules: a prefix narrows the hunt, and a section
 * never outranks a better row from another section.
 */
import { describe, expect, it } from "vitest";

import {
  fieldsOf,
  parseQuery,
  restingOrder,
  sectionsOf,
  type PaletteEntry,
} from "./model";

const entry = (
  id: string,
  kind: PaletteEntry["kind"],
  title: string,
  extra: Partial<PaletteEntry> = {},
): PaletteEntry => ({ id, kind, title, run: () => {}, ...extra });

describe("parseQuery", () => {
  it("reads a scope prefix and hands back the rest", () => {
    const parsed = parseQuery(">novo term");
    expect(parsed.scope?.kinds).toEqual(["action"]);
    expect(parsed.text).toBe("novo term");
  });

  it("treats a path as a file filter, not as a path", () => {
    const parsed = parseQuery("/src/lib");
    expect(parsed.scope?.kinds).toEqual(["file"]);
    expect(parsed.text).toBe("src/lib");
  });

  it("only honours the prefix at the start", () => {
    const parsed = parseQuery("nota > coisa");
    expect(parsed.scope).toBeNull();
    expect(parsed.text).toBe("nota > coisa");
  });

  it("takes a bare prefix as an empty search inside the scope", () => {
    const parsed = parseQuery("@");
    expect(parsed.scope?.kinds).toEqual(["terminal"]);
    expect(parsed.text).toBe("");
  });

  it("ignores leading spaces before the prefix", () => {
    expect(parseQuery("  #nota").scope?.prefix).toBe("#");
    expect(parseQuery("  #nota").text).toBe("nota");
  });
});

describe("sectionsOf", () => {
  it("places a section where its best row landed", () => {
    // Ranked list: a file beat every action, so "Arquivos" comes first even
    // though actions normally sit above files.
    const sections = sectionsOf([
      entry("f1", "file", "search.ts"),
      entry("a1", "action", "Novo terminal"),
      entry("f2", "file", "search.test.ts"),
    ]);
    expect(sections.map((s) => s.kind)).toEqual(["file", "action"]);
    expect(sections[0].entries.map((e) => e.id)).toEqual(["f1", "f2"]);
  });

  it("returns nothing for an empty list", () => {
    expect(sectionsOf([])).toEqual([]);
  });
});

describe("restingOrder", () => {
  it("uses the fixed section order when nothing was typed", () => {
    const ordered = restingOrder([
      entry("p", "project", "Yard"),
      entry("a", "action", "Novo terminal"),
      entry("t", "terminal", "claude"),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["t", "a", "p"]);
  });

  it("puts the heavier row first inside a section", () => {
    const ordered = restingOrder([
      entry("far", "terminal", "codex", { weight: 0 }),
      entry("near", "terminal", "claude", { weight: 50 }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["near", "far"]);
  });

  it("keeps the input order when kind and weight tie", () => {
    const ordered = restingOrder([
      entry("1", "terminal", "a"),
      entry("2", "terminal", "b"),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["1", "2"]);
  });
});

describe("fieldsOf", () => {
  it("searches the title, the subtitle and the hidden keywords", () => {
    const fields = fieldsOf(
      entry("a", "action", "Novo terminal", {
        subtitle: "no grupo ativo",
        keywords: ["ctrl+t", "shell"],
      }),
    );
    expect(fields).toEqual(["Novo terminal", "no grupo ativo", "ctrl+t", "shell"]);
  });

  it("skips what is not there", () => {
    expect(fieldsOf(entry("a", "action", "Só o título"))).toEqual(["Só o título"]);
  });
});
