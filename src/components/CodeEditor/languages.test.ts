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
    [".gitignore", "Ignore"],
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

/**
 * The files a repository is made of that are not its code: the dotfiles, the
 * rc files, the manifests. They are the ones a colour scheme was quietly not
 * reaching — not because the theme was wrong, but because the *grammar* was
 * missing, and a file with no grammar opens as plain text, in one ink, in
 * every theme there is.
 *
 * `.gitignore` is the one that was worse than missing. It resolved to the
 * `.properties` mode, which reads a leading `!` as a comment — so the negation,
 * the single most load-bearing line the format has, was drawn in the ink the
 * editor uses for "this does not count" (`ignoreSyntax.test.ts`).
 */
describe("the files around a repository", () => {
  /** Every name here has to open on a grammar, not on plain text. */
  const COLOURED: [string, string][] = [
    // The ignore family — one format, five filenames, its own grammar now.
    [".gitignore", "Ignore"],
    [".dockerignore", "Ignore"],
    [".npmignore", "Ignore"],
    [".eslintignore", "Ignore"],
    [".prettierignore", "Ignore"],
    // The rc files that are strict JSON, and the JSON that is not called .json
    [".swcrc", "JSON"],
    [".releaserc", "JSON"],
    [".stylelintrc", "JSON"],
    [".lintstagedrc", "JSON"],
    [".commitlintrc", "JSON"],
    [".markdownlintrc", "JSON"],
    ["notebook.ipynb", "JSON"],
    ["schema.avsc", "JSON"],
    // The ini/properties family, past the three it already knew
    [".flake8", "Config"],
    [".pylintrc", "Config"],
    [".coveragerc", "Config"],
    [".yarnrc", "Config"],
    [".inputrc", "Config"],
    // YAML and TOML wearing no extension
    [".clang-format", "YAML"],
    [".yamllint", "YAML"],
    ["Pipfile", "TOML"],
    ["poetry.lock", "TOML"],
    // The Ruby DSLs that name themselves after the tool
    ["Vagrantfile", "Ruby"],
    ["Brewfile", "Ruby"],
    ["Podfile", "Ruby"],
    ["Fastfile", "Ruby"],
    ["Gemfile", "Ruby"],
  ];

  it.each(COLOURED)("%s opens as %s, not as plain text", (path, label) => {
    expect(languageLabel(path)).toBe(label);
  });

  it("every one of them actually has a grammar to colour it with", () => {
    const byLabel = new Map(LANGUAGES.map((s) => [s.label, s]));
    for (const [path, label] of COLOURED) {
      expect(byLabel.get(label)?.load, `${path} → ${label}`).toBeDefined();
    }
  });

  /**
   * The other half of honest coverage. These have no grammar on the shelf, and
   * a near-miss grammar reads worse than none — so they are *named* and left
   * uncoloured, the way Zig and Elixir already are. Naming them is not
   * cosmetic: the status bar saying "Terraform" is how you know the editor
   * recognised the file and chose not to guess at it.
   */
  const NAMED: [string, string][] = [
    // Make, under its other names — labelled for years, and still uncoloured:
    // no Makefile grammar ships with the legacy modes.
    ["build.mk", "Makefile"],
    ["Makefile.am", "Makefile"],
    ["main.tf", "Terraform"],
    ["prod.tfvars", "Terraform"],
    ["stack.hcl", "HCL"],
    ["schema.prisma", "Prisma"],
    ["Token.sol", "Solidity"],
    ["flake.nix", "Nix"],
    ["guide.rst", "reStructuredText"],
    ["guide.adoc", "AsciiDoc"],
  ];

  it.each(NAMED)("%s is named %s even with no grammar to draw it", (path, label) => {
    expect(languageLabel(path)).toBe(label);
  });

  /**
   * The regression that motivated the ignore grammar, stated where the routing
   * lives: `.gitignore` must not go back to the config mode it used to share
   * with `.editorconfig`. They look alike and are not — one is `key=value`
   * with `#`, `!` and `;` all opening comments; the other is globs, where `!`
   * inverts the line.
   */
  it("no longer sends .gitignore to the config mode that inverted its meaning", () => {
    expect(languageLabel(".gitignore")).not.toBe(languageLabel(".editorconfig"));
    expect(languageLabel(".editorconfig")).toBe("Config");
  });
});
