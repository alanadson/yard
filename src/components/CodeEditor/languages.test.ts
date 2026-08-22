import { describe, expect, it } from "vitest";

import {
  fenceLabel,
  fenceLanguages,
  isMarkdown,
  LANGUAGES,
  languageLabel,
} from "./languages";

describe("languageLabel", () => {
  // One path per family that matters — the famous ones a top editor must name.
  const casos: [string, string][] = [
    ["src/main.rs", "Rust"],
    ["src/util.c", "C"],
    ["src/util.h", "C"],
    ["src/app.cpp", "C++"],
    ["src/app.hpp", "C++"],
    ["Program.cs", "C#"],
    ["Main.java", "Java"],
    ["main.go", "Go"],
    ["app.py", "Python"],
    ["index.php", "PHP"],
    ["app.rb", "Ruby"],
    ["App.swift", "Swift"],
    ["Main.kt", "Kotlin"],
    ["Build.scala", "Scala"],
    ["view.m", "Objective-C"],
    ["init.lua", "Lua"],
    ["script.pl", "Perl"],
    ["stats.r", "R"],
    ["solve.jl", "Julia"],
    ["main.hs", "Haskell"],
    ["core.clj", "Clojure"],
    ["server.erl", "Erlang"],
    ["app.ex", "Elixir"],
    ["main.dart", "Dart"],
    ["query.sql", "SQL"],
    ["deploy.sh", "Shell"],
    ["build.ps1", "PowerShell"],
    ["config.toml", "TOML"],
    ["Cargo.lock", "TOML"],
    ["config.xml", "XML"],
    ["icon.svg", "XML"],
    ["schema.graphql", "GraphQL"],
    ["build.gradle", "Groovy"],
    ["types.proto", "Protobuf"],
    ["fix.patch", "Diff"],
    ["paper.tex", "LaTeX"],
    ["Dockerfile", "Dockerfile"],
    ["Dockerfile.dev", "Dockerfile"],
    ["Makefile", "Makefile"],
    ["CMakeLists.txt", "CMake"],
    [".env", "Config"],
    [".env.local", "Config"],
    [".gitignore", "Config"],
    ["App.vue", "Vue"],
    ["App.svelte", "Svelte"],
    ["style.scss", "SCSS"],
    ["style.less", "Less"],
    ["run.bat", "Batch"],
    ["notas.txt", "Texto"],
    ["sem-extensao", "Texto"],
  ];

  it.each(casos)("%s → %s", (path, label) => {
    expect(languageLabel(path)).toBe(label);
  });
});

describe("the registry", () => {
  it("does not let two languages fight over the same extension", () => {
    const seen = new Map<string, string>();
    for (const spec of LANGUAGES) {
      for (const e of spec.ext ?? []) {
        expect(seen.get(e), `extension .${e} in ${spec.key} and ${seen.get(e)}`).toBeUndefined();
        seen.set(e, spec.key);
      }
    }
  });

  it("does not let two languages fight over the same filename", () => {
    const vistos = new Map<string, string>();
    for (const spec of LANGUAGES) {
      for (const n of spec.names ?? []) {
        expect(vistos.get(n), `name ${n} in ${spec.key} and ${vistos.get(n)}`).toBeUndefined();
        vistos.set(n, spec.key);
      }
    }
  });

  // The one test that keeps the table honest: every grammar import resolves
  // and hands back a language. A typo'd legacy-modes export dies here, not in
  // the hand of whoever opens a `.swift` three weeks from now.
  it("loads every grammar it promises", async () => {
    const comGramatica = LANGUAGES.filter((l) => l.load);
    expect(comGramatica.length).toBeGreaterThan(40);
    for (const spec of comGramatica) {
      const support = await spec.load!();
      expect(support?.language, spec.key).toBeTruthy();
    }
  }, 30_000);

  it("reads the YAML frontmatter of a markdown file", async () => {
    const md = LANGUAGES.find((l) => l.key === "markdown")!;
    const support = await md.load!();
    const tree = support.language.parser.parse("---\ntitle: Yard\n---\n\n# Título\n");
    expect(tree.toString()).toContain("Frontmatter");
  });
});

describe("markdown fences", () => {
  it("recognizes the well-established aliases", () => {
    // matchLanguageName is what @codemirror/lang-markdown uses on ```info.
    const names = ["ts", "typescript", "js", "rust", "c++", "c#", "golang", "sh", "matlab"];
    for (const itemName of names) {
      const desc = fenceLanguages.find(
        (d) => d.name === itemName || d.alias.includes(itemName),
      );
      expect(desc, itemName).toBeTruthy();
    }
  });

  it("gives the block header a human-readable name", () => {
    expect(fenceLabel("ts")).toBe("TypeScript");
    expect(fenceLabel("c#")).toBe("C#");
    expect(fenceLabel("pwsh")).toBe("PowerShell");
    expect(fenceLabel("linguagem-inventada")).toBe("linguagem-inventada");
    expect(fenceLabel("")).toBe("");
  });
});

describe("isMarkdown", () => {
  it("accepts only the markdown family", () => {
    expect(isMarkdown("README.md")).toBe(true);
    expect(isMarkdown("post.mdx")).toBe(true);
    expect(isMarkdown("main.rs")).toBe(false);
  });
});
