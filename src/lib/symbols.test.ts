import { describe, expect, it } from "vitest";

import { enclosing, hasSymbolSupport, symbolsOf } from "./symbols";

describe("symbolsOf", () => {
  it("typescript: function, class, type and arrow const", () => {
    const text = [
      "export function abrir(path: string) {",
      "const soma = (a: number, b: number) => a + b;",
      "export class Fila<T> {",
      "  push(item: T) {",
      "  }",
      "}",
      "export interface Doc {",
      "type Modo = 'a' | 'b';",
      "if (x) {",
    ].join("\n");
    const names = symbolsOf("src/a.ts", text).map((s) => s.text);
    expect(names).toContain("abrir");
    expect(names).toContain("soma");
    expect(names).toContain("class Fila");
    expect(names).toContain("push");
    expect(names).toContain("interface Doc");
    expect(names).toContain("type Modo");
    expect(names).not.toContain("if");
  });

  it("level follows the indentation", () => {
    const text = ["export class A {", "    metodo() {", "}"].join("\n");
    const symbols = symbolsOf("x.ts", text);
    expect(symbols[0].level).toBe(1);
    expect(symbols[1].level).toBe(2);
    expect(symbols[1].line).toBe(1);
  });

  it("python: def and class", () => {
    const text = ["class Fila:", "    def push(self, x):", "async def main():"].join("\n");
    const names = symbolsOf("a.py", text).map((s) => s.text);
    expect(names).toEqual(["class Fila", "push", "main"]);
  });

  it("rust: fn, struct, impl", () => {
    const text = [
      "pub fn resolve(root: &Path) {}",
      "struct Doc {",
      "impl Doc {",
      "    fn len(&self) -> usize {",
      "pub(crate) enum Modo {",
    ].join("\n");
    const names = symbolsOf("a.rs", text).map((s) => s.text);
    expect(names).toEqual(["resolve", "struct Doc", "impl Doc", "len", "enum Modo"]);
  });

  it("go: func with receiver", () => {
    const text = ["func (s *Server) Start() error {", "type Config struct {"].join("\n");
    const names = symbolsOf("main.go", text).map((s) => s.text);
    expect(names).toEqual(["Start", "type Config"]);
  });

  it("yaml: only the top-level keys", () => {
    const text = ["name: yard", "jobs:", "  build:", "    steps:"].join("\n");
    const names = symbolsOf("ci.yml", text).map((s) => s.text);
    expect(names).toEqual(["name", "jobs"]);
  });

  it("a language with no pattern returns empty", () => {
    expect(symbolsOf("a.zig", "fn main() void {}")).toEqual([]);
    expect(hasSymbolSupport("a.zig")).toBe(false);
    expect(hasSymbolSupport("a.ts")).toBe(true);
  });
});


/**
 * The trail of symbols the caret is standing inside, what the document
 * header shows after the file name, so a reader three hundred lines into a
 * class still knows which method they are in.
 *
 * It is an approximation, and deliberately so: this list is regex-built and
 * knows where a symbol *starts*, never where it ends. The stack rule (a
 * symbol at a given depth closes every symbol at that depth or deeper) is
 * what indentation already tells the eye, which is the same thing the reader
 * is doing when they scroll up to find out where they are.
 */
describe("enclosing", () => {
  const symbols = [
    { level: 1, text: "class Fila", line: 2 },
    { level: 2, text: "push", line: 4 },
    { level: 3, text: "grow", line: 7 },
    { level: 2, text: "pop", line: 12 },
    { level: 1, text: "class Pilha", line: 20 },
  ];

  it("has nothing to show above the first symbol", () => {
    expect(enclosing(symbols, 0)).toEqual([]);
  });

  it("names the symbol the caret is on", () => {
    expect(enclosing(symbols, 2).map((s) => s.text)).toEqual(["class Fila"]);
  });

  it("builds the chain from the outside in", () => {
    expect(enclosing(symbols, 8).map((s) => s.text)).toEqual([
      "class Fila",
      "push",
      "grow",
    ]);
  });

  it("closes the deeper symbols when one at the same depth starts", () => {
    // `pop` is a sibling of `push`, so neither `push` nor `grow` can still be
    // open by the time the caret gets there.
    expect(enclosing(symbols, 13).map((s) => s.text)).toEqual(["class Fila", "pop"]);
  });

  it("closes everything when a top-level symbol starts", () => {
    expect(enclosing(symbols, 21).map((s) => s.text)).toEqual(["class Pilha"]);
  });

  it("ignores symbols the caret has not reached", () => {
    expect(enclosing(symbols, 5).map((s) => s.text)).toEqual(["class Fila", "push"]);
  });

  it("says nothing about a file with no symbols", () => {
    expect(enclosing([], 40)).toEqual([]);
  });
});
