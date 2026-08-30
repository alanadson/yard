/**
 * The outline, when a language server is answering.
 *
 * `lib/symbols.ts` builds the rail from line-shaped regexes, which is the
 * right floor: it works with nothing installed, in fifty languages, and it
 * never lies about *where* a symbol is because it reads the line it is on.
 * What it cannot do is know that `push` belongs to `Fila` rather than to the
 * indentation it happens to share, or that a decorated, multi-line signature
 * is one declaration.
 *
 * A server knows both. The catch is that `textDocument/documentSymbol` has
 * two shapes on the wire, the modern nested one and the flat one that older
 * servers still answer with, and the reply arrives as bare JSON from a
 * process nobody in this repository controls. So everything below is about
 * reading a stranger's answer without trusting it.
 */
import { describe, expect, it } from "vitest";

import { flattenSymbols } from "./documentSymbols";

describe("flattenSymbols, nested reply", () => {
  const reply = [
    {
      name: "Fila",
      kind: 5,
      range: { start: { line: 2, character: 0 }, end: { line: 18, character: 1 } },
      selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 10 } },
      children: [
        {
          name: "push",
          kind: 6,
          range: { start: { line: 4, character: 2 }, end: { line: 8, character: 3 } },
          selectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } },
          children: [
            {
              name: "grow",
              kind: 12,
              range: { start: { line: 6, character: 4 }, end: { line: 7, character: 5 } },
              selectionRange: { start: { line: 6, character: 4 }, end: { line: 6, character: 8 } },
            },
          ],
        },
      ],
    },
  ];

  it("reads the nesting the server reported, not the indentation", () => {
    // This is the whole reason to prefer the server: depth here is a fact
    // about the code, and in the regex outline it is a guess about spaces.
    expect(flattenSymbols(reply)).toEqual([
      { level: 1, text: "class Fila", line: 2 },
      { level: 2, text: "push", line: 4 },
      { level: 3, text: "grow", line: 6 },
    ]);
  });

  it("names the kinds a reader scans for and leaves the rest bare", () => {
    const kinds = [
      { name: "Doc", kind: 11, range: r(0), selectionRange: r(0) },
      { name: "Cor", kind: 10, range: r(1), selectionRange: r(1) },
      { name: "Ponto", kind: 23, range: r(2), selectionRange: r(2) },
      { name: "abrir", kind: 12, range: r(3), selectionRange: r(3) },
      { name: "total", kind: 13, range: r(4), selectionRange: r(4) },
    ];

    expect(flattenSymbols(kinds).map((s) => s.text)).toEqual([
      "interface Doc",
      "enum Cor",
      "struct Ponto",
      "abrir",
      "total",
    ]);
  });

  it("puts the symbols in document order whatever order they arrived in", () => {
    const jumbled = [
      { name: "b", kind: 12, range: r(40), selectionRange: r(40) },
      { name: "a", kind: 12, range: r(4), selectionRange: r(4) },
    ];

    expect(flattenSymbols(jumbled).map((s) => s.line)).toEqual([4, 40]);
  });
});

describe("flattenSymbols, flat reply", () => {
  it("reads the older SymbolInformation shape", () => {
    const reply = [
      {
        name: "Fila",
        kind: 5,
        location: { uri: "file:///c:/r/a.ts", range: r(2) },
      },
      {
        name: "push",
        kind: 6,
        containerName: "Fila",
        location: { uri: "file:///c:/r/a.ts", range: r(4) },
      },
    ];

    expect(flattenSymbols(reply)).toEqual([
      { level: 1, text: "class Fila", line: 2 },
      { level: 2, text: "push", line: 4 },
    ]);
  });
});

describe("flattenSymbols, a reply we cannot use", () => {
  it("has nothing to show when the server said nothing", () => {
    // Every one of these is a real answer from a real server: null while it
    // is still indexing, an empty array for a file it does not parse.
    expect(flattenSymbols(null)).toEqual([]);
    expect(flattenSymbols(undefined)).toEqual([]);
    expect(flattenSymbols([])).toEqual([]);
  });

  it("skips an entry it cannot place instead of dropping the reply", () => {
    // One malformed symbol must not cost the outline the other forty.
    const reply = [
      { name: "ok", kind: 12, range: r(3), selectionRange: r(3) },
      { name: "no range" },
      { kind: 12, range: r(5), selectionRange: r(5) },
      "nonsense",
    ];

    expect(flattenSymbols(reply).map((s) => s.text)).toEqual(["ok"]);
  });

  it("refuses a reply that is not a list at all", () => {
    expect(flattenSymbols({ symbols: [] })).toEqual([]);
    expect(flattenSymbols("[]")).toEqual([]);
  });

  it("stops at the same ceiling the regex outline uses", () => {
    const many = Array.from({ length: 900 }, (_, i) => ({
      name: `f${i}`,
      kind: 12,
      range: r(i),
      selectionRange: r(i),
    }));

    expect(flattenSymbols(many).length).toBeLessThanOrEqual(500);
  });
});

function r(line: number) {
  return { start: { line, character: 0 }, end: { line, character: 1 } };
}
