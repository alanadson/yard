/**
 * What `main.tsx` pulls into the startup chunk, before the first pixel.
 *
 * The editor, its language servers and the markdown renderer are lazy on
 * purpose: `App` reaches them through `lazy(() => import(...))`, so a boot that
 * never opens a file never reads them. That promise breaks silently, with
 * one ordinary import. `useLspLifecycle` reached `lspStore`, which imported
 * `@codemirror/lsp-client` by value; `editorStore` imported two pure helpers
 * from a module that also imported `@codemirror/language`. Each looked
 * harmless, and together they put CodeMirror, lezer and `marked` into the
 * entry chunk: about 420 kB, a third of it, parsed on every boot by people
 * who never open a file. Nothing on screen shows it, the bundle only grows.
 *
 * So this walks the static import graph from `main.tsx`, the same edges the
 * bundler follows (a type-only import is erased, an `import()` is a separate
 * chunk), and fails with the chain that reaches a forbidden package.
 */
import { describe, expect, it } from "vitest";

// The file list comes from `import.meta.glob`, the resolver the app uses, but
// only its keys: a glob that is not eager fetches nothing. The text comes from
// node's `fs`, through an untyped dynamic import, so the suite still needs no
// `@types/node` and no new dependency. `?raw` gave the same bytes, but it sent
// every module the walk reads (about 240, half of `src`) through the one vite
// server inside this test's 5 s budget, while that server also transforms for
// every other worker; with the machine busy (cargo test beside it) the walk
// took 2 to 5 s and timed out. Read from disk it takes tens of milliseconds.
// Still read on demand: only the modules the entry reaches.
const FS = "node:fs/promises";
const fsp = import(/* @vite-ignore */ FS) as Promise<{
  readFile(path: URL, encoding: "utf8"): Promise<string>;
}>;
const LOADERS: Record<string, () => Promise<string>> = Object.fromEntries(
  Object.keys(import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"])).map((path) => [
    path.slice(2),
    async () => (await fsp).readFile(new URL(path, import.meta.url), "utf8"),
  ]),
);

/** Packages that only lazy chunks may bring. */
const LAZY_ONLY = /^(@codemirror\/|@lezer\/|marked$)/;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** A `{ a, type B }` list whose every name is a type is erased whole. */
function onlyTypes(clause: string): boolean {
  const c = clause.trim();
  if (!c.startsWith("{") || !c.endsWith("}")) return false;
  const names = c
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith("type "));
}

/**
 * The specifiers a module loads the moment it is evaluated. Stricter than
 * the bundler in one place: a value import that is only ever used as a type
 * still counts here. Writing it `import type` is the fix, and says so.
 */
function eagerSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const IMPORT = /\bimport\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s*["']([^"']+)["']/g;
  const BARE = /\bimport\s*["']([^"']+)["']/g;
  const REEXPORT = /\bexport\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(IMPORT)) if (!m[1] && !onlyTypes(m[2])) out.push(m[3]);
  for (const m of code.matchAll(BARE)) out.push(m[1]);
  for (const m of code.matchAll(REEXPORT)) if (!m[1] && !onlyTypes(m[2])) out.push(m[3]);
  return out;
}

function join(fromFile: string, spec: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const piece of spec.split("?")[0].split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = join(fromFile, spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (candidate in LOADERS) return candidate;
  }
  return null;
}

function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Every module and package the entry evaluates, each with who brought it.
 * Breadth first, one level of the graph read at a time.
 */
async function walk(entry: string) {
  const parent = new Map<string, string | null>([[entry, null]]);
  const packages = new Map<string, string>();
  let level = [entry];
  while (level.length) {
    const sources = await Promise.all(level.map((file) => LOADERS[file]()));
    const next: string[] = [];
    level.forEach((file, i) => {
      for (const spec of eagerSpecifiers(sources[i])) {
        if (!spec.startsWith(".")) {
          const name = packageOf(spec);
          if (!packages.has(name)) packages.set(name, file);
          continue;
        }
        const local = resolveLocal(file, spec);
        if (local && !parent.has(local)) {
          parent.set(local, file);
          next.push(local);
        }
      }
    });
    level = next;
  }
  const chainTo = (file: string): string => {
    const chain: string[] = [];
    for (let f: string | null | undefined = file; f; f = parent.get(f)) chain.unshift(f);
    return chain.join(" -> ");
  };
  return { files: new Set(parent.keys()), packages, chainTo };
}

let boot: ReturnType<typeof walk> | null = null;
/** The graph from `main.tsx`, walked once for the whole file. */
const eagerGraph = (): ReturnType<typeof walk> => (boot ??= walk("main.tsx"));

describe("reading the import graph", () => {
  it("counts value imports, re-exports and side-effect imports", () => {
    const source = [
      'import React from "react";',
      'import { a, type B } from "./a";',
      'import * as ns from "../ns";',
      'import "./styles.css";',
      'export { c } from "./c";',
      'export * from "./d";',
    ].join("\n");

    expect(eagerSpecifiers(source).sort()).toEqual(
      ["../ns", "./a", "./c", "./d", "./styles.css", "react"].sort(),
    );
  });

  it("skips what the bundler erases or splits off", () => {
    const source = [
      'import type { LSPClient } from "@codemirror/lsp-client";',
      'import { type EditorState, type Extension } from "@codemirror/state";',
      'export type { Tag } from "@lezer/highlight";',
      'const Editor = lazy(() => import("./components/CodeEditor"));',
      'const lib = await import("@codemirror/lsp-client");',
      '// import { EditorView } from "@codemirror/view";',
      '/* import { marked } from "marked"; */',
    ].join("\n");

    expect(eagerSpecifiers(source)).toEqual([]);
  });

  it("finds the boot surface, so a moved file cannot silence the rule below", async () => {
    const { files } = await eagerGraph();

    expect(files).toContain("App.tsx");
    expect(files).toContain("stores/editorStore.ts");
    expect(files).toContain("stores/lspStore.ts");
    expect(files).toContain("hooks/useLspLifecycle.ts");
    expect(files.size).toBeGreaterThan(100);
  });
});

describe("the startup chunk", () => {
  it("does not carry CodeMirror, lezer or marked", async () => {
    const { packages, chainTo } = await eagerGraph();
    const leaks = [...packages]
      .filter(([name]) => LAZY_ONLY.test(name))
      .map(([name, from]) => `${name} <- ${chainTo(from)}`);

    expect(leaks).toEqual([]);
  });

  /**
   * About 224 kB, 17% of the chunk, for a language most boots never speak:
   * Portuguese is the default, and `lib/i18n.ts` fetches the English lines
   * only once English is resolved. One static import of `i18n/en` from
   * anything the entry reaches puts all of it back, with nothing on screen
   * to show it.
   */
  it("does not carry the English dictionary", async () => {
    const { files, chainTo } = await eagerGraph();
    const leaks = [...files].filter((file) => file.startsWith("i18n/en/")).map(chainTo);

    // The module that loads it is on the boot path, so the walk did look.
    expect(files).toContain("lib/i18n.ts");
    expect(leaks).toEqual([]);
  });
});
