/**
 * The handful of shapes worth not typing.
 *
 * Deliberately small, and deliberately not configurable. A snippet library
 * people can edit becomes a second thing to maintain and a first thing to
 * forget; what earns its place here is the shape you write ten times a day
 * and always get one brace wrong on the tenth.
 *
 * These sit under whatever the grammar and the language server already offer:
 * completion from a server is about *this project*, and a snippet is about
 * the language, so the server has to win.
 */
import { describe, expect, it } from "vitest";

import { SNIPPETS, snippetsFor } from "./snippets";

describe("snippetsFor", () => {
  it("gives a TypeScript file the TypeScript shapes", () => {
    const labels = snippetsFor("src/a.ts").map((s) => s.label);

    expect(labels).toContain("fn");
    expect(labels).toContain("log");
  });

  it("treats the whole JavaScript family as one", () => {
    for (const path of ["a.js", "a.jsx", "a.tsx", "a.mts", "a.cjs"]) {
      expect(snippetsFor(path).length).toBeGreaterThan(0);
    }
  });

  it("gives Rust its own, and not JavaScript's", () => {
    const labels = snippetsFor("src/main.rs").map((s) => s.label);

    expect(labels).toContain("test");
    expect(labels).not.toContain("log");
  });

  it("has nothing for a language it does not know", () => {
    expect(snippetsFor("a.cobol")).toEqual([]);
    expect(snippetsFor("Makefile")).toEqual([]);
  });

  it("has nothing for markdown, which is prose", () => {
    // The markdown editor already has a formatting bar and its own keys;
    // offering `for` while someone writes a README is noise.
    expect(snippetsFor("README.md")).toEqual([]);
  });

  it("reads the extension whatever the case", () => {
    expect(snippetsFor("src/A.TS").length).toBeGreaterThan(0);
  });
});

describe("the tables themselves", () => {
  it("names every snippet once inside its family", () => {
    // Two rows with the same label in one list is a menu the reader cannot
    // choose from.
    for (const [family, rows] of Object.entries(SNIPPETS)) {
      const labels = rows.map((r) => r.label);
      expect(new Set(labels).size, `duplicate label in ${family}`).toBe(labels.length);
    }
  });

  it("gives every snippet something to insert and something to read", () => {
    for (const rows of Object.values(SNIPPETS)) {
      for (const row of rows) {
        expect(row.label.length).toBeGreaterThan(0);
        expect(row.template.length).toBeGreaterThan(0);
        expect(row.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it("closes every placeholder it opens", () => {
    // CodeMirror reads `${...}` as a hole to tab through. An unclosed one is
    // not an error, it is a snippet that inserts a literal `${` into the
    // file, which nobody notices until it is committed.
    for (const rows of Object.values(SNIPPETS)) {
      for (const row of rows) {
        const opens = (row.template.match(/\$\{/g) ?? []).length;
        const closes = (row.template.match(/\}/g) ?? []).length;
        expect(closes, `${row.label} leaves a placeholder open`).toBeGreaterThanOrEqual(opens);
      }
    }
  });
});
