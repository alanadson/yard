import { describe, expect, it } from "vitest";

import { hasSymbolSupport, symbolsOf } from "./symbols";

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
