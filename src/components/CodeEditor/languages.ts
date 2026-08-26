/**
 * The language registry — every grammar the editor knows how to color.
 *
 * One table drives everything: the file the editor opens, the ```fence inside
 * a markdown document, and the label in the status bar all resolve against the
 * same list. Adding a language is one entry here, nowhere else.
 *
 * Two kinds of grammar live side by side:
 * - **Lezer parsers** (`@codemirror/lang-*`), for the languages CodeMirror
 *   maintains first-class — incremental, tree-based, the best highlighting
 *   available;
 * - **stream parsers** (`@codemirror/legacy-modes`), the CodeMirror 5 modes
 *   re-packaged — line-based but accurate, and the only way to cover the long
 *   tail (C#, Swift, Kotlin, Ruby, Lua, TOML…) without hand-writing grammars.
 *
 * Every grammar is a lazy `import()`: opening a `.rs` costs nothing until it
 * happens, and Vite splits each one into its own chunk. Anything not in the
 * table opens as plain text — no coloring beats coloring it wrong.
 *
 * This module deliberately does not import `@codemirror/view`: the theme
 * lives in `cm.ts`, and the registry stays importable from tests (and anywhere
 * else) without dragging the editor along.
 */
import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from "@codemirror/language";
import { Tag, tags as t } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import type { Extension } from "@codemirror/state";

// ---------------------------------------------------------------------------
// the app's markdown dialect
// ---------------------------------------------------------------------------

/**
 * `==highlight==` — the one thing this app's markdown has that GFM does not.
 *
 * The canvas note already writes it (the bar has a highlighter), the note's
 * renderer already paints it, and the editor has to speak the same dialect:
 * a file and a sticky note holding the same text must not disagree about
 * what it says. Defined as a grammar extension, so the highlighting, the
 * live preview and the folding all learn it at once.
 */
export const highlightTag = Tag.define();

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export const markdownHighlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // 61 = `=`; only the doubled form marks anything.
        if (next !== 61 || cx.char(pos + 1) !== 61) return -1;
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true);
      },
      after: "Emphasis",
    },
  ],
};

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

/** One language the editor can name — and usually color. */
export interface LangSpec {
  /** Stable id: the grammar cache key and the fence's canonical name. */
  key: string;
  /** What the status bar (and the fence header) shows. */
  label: string;
  /** File extensions, lowercase, without the dot. */
  ext?: readonly string[];
  /** Whole filenames, lowercase — for the files that have no extension. */
  names?: readonly string[];
  /** Extra names a ```fence may use (`key` and `ext` already count). */
  fence?: readonly string[];
  /** Absent on purpose for the labeled-but-uncolored ones (Makefile, Zig…). */
  load?: () => Promise<LanguageSupport>; // i18n-ok — not a sentence
}

/** Wraps a CodeMirror 5 mode as the same `LanguageSupport` a Lezer one gives. */
const legacy =
  (load: () => Promise<StreamParser<unknown>>) => (): Promise<LanguageSupport> => // i18n-ok — not a sentence
    load().then((parser) => new LanguageSupport(StreamLanguage.define(parser)));

const NO_LANGUAGE: LangSpec = { key: "text", label: "Texto" }; // i18n-ok — translated where rendered

/**
 * The table. Ordered by family for the human reading it — the lookups below
 * index it, so order carries no meaning to the machine.
 */
export const LANGUAGES: readonly LangSpec[] = [
  // --- the web stack (Lezer, first-class) ---------------------------------
  {
    key: "typescript",
    label: "TypeScript",
    ext: ["ts", "mts", "cts"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  },
  {
    key: "tsx",
    label: "TypeScript JSX",
    ext: ["tsx"],
    fence: ["typescript-jsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ typescript: true, jsx: true }),
      ),
  },
  {
    // JSX on for plain `.js` too: React projects use the extension freely, and
    // the parser reads ordinary JavaScript the same either way.
    key: "javascript",
    label: "JavaScript",
    ext: ["js", "mjs", "cjs", "jsx"],
    fence: ["node"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  },
  {
    key: "json",
    label: "JSON",
    ext: ["json", "jsonc", "webmanifest", "geojson", "map"],
    names: [".babelrc", ".eslintrc", ".prettierrc"],
    // The one grammar that ships a linter worth having: `JSON.parse` either
    // accepts the file or points at the byte it refused — squiggle and all.
    load: () =>
      Promise.all([import("@codemirror/lang-json"), import("@codemirror/lint")]).then(
        ([json, lint]) =>
          new LanguageSupport(json.jsonLanguage, lint.linter(json.jsonParseLinter())),
      ),
  },
  {
    key: "css",
    label: "CSS",
    ext: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  },
  {
    key: "scss",
    label: "SCSS",
    ext: ["scss"],
    load: () => import("@codemirror/lang-sass").then((m) => m.sass()),
  },
  {
    key: "sass",
    label: "Sass",
    ext: ["sass"],
    load: () => import("@codemirror/lang-sass").then((m) => m.sass({ indented: true })),
  },
  {
    key: "less",
    label: "Less",
    ext: ["less"],
    load: () => import("@codemirror/lang-less").then((m) => m.less()),
  },
  {
    key: "html",
    label: "HTML",
    ext: ["html", "htm"],
    fence: ["xhtml"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    // Their own entries for the label's sake; HTML reads both well enough
    // until CodeMirror grows real grammars for them.
    key: "svelte",
    label: "Svelte",
    ext: ["svelte"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    key: "astro",
    label: "Astro",
    ext: ["astro"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    key: "vue",
    label: "Vue",
    ext: ["vue"],
    load: () => import("@codemirror/lang-vue").then((m) => m.vue()),
  },
  {
    key: "xml",
    label: "XML",
    ext: ["xml", "xsd", "xsl", "xslt", "svg", "plist", "xaml", "csproj", "resx"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  },
  {
    key: "markdown",
    label: "Markdown",
    ext: ["md", "markdown", "mdx"],
    fence: ["gfm"],
    // GFM (tables, task lists, strikethrough) plus this app's `==highlight==`
    // — and the fenced blocks inside the file get their own language, so a
    // ```ts inside a README reads like TypeScript instead of grey text.
    // The whole thing sits behind `yamlFrontmatter`: the `---` header half
    // the docs in a repo open with parses as YAML, instead of being read as
    // a horizontal rule, a paragraph of `key: value` and a setext heading.
    // (The preview's own parser, `mddoc.ts`, already does the same.)
    load: () =>
      Promise.all([
        import("@codemirror/lang-markdown"),
        import("@codemirror/lang-yaml"),
      ]).then(([md, yaml]) =>
        yaml.yamlFrontmatter({
          content: md.markdown({
            base: md.markdownLanguage,
            extensions: [markdownHighlight],
            codeLanguages: fenceLanguages,
          }),
        }),
      ),
  },

  // --- systems languages (Lezer) ------------------------------------------
  {
    key: "c",
    label: "C",
    ext: ["c", "h"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  },
  {
    key: "cpp",
    label: "C++",
    ext: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"],
    fence: ["c++"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  },
  {
    key: "rust",
    label: "Rust",
    ext: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  },
  {
    key: "go",
    label: "Go",
    ext: ["go"],
    fence: ["golang"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  },
  {
    key: "java",
    label: "Java",
    ext: ["java"],
    load: () => import("@codemirror/lang-java").then((m) => m.java()),
  },
  {
    key: "python",
    label: "Python",
    ext: ["py", "pyi", "pyw"],
    fence: ["python3"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  },
  {
    key: "php",
    label: "PHP",
    ext: ["php", "phtml"],
    load: () => import("@codemirror/lang-php").then((m) => m.php()),
  },
  {
    key: "sql",
    label: "SQL",
    ext: ["sql"],
    fence: ["mysql", "postgres", "postgresql", "pgsql", "plsql", "sqlite", "tsql"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  },

  // --- the C-like family (stream) -----------------------------------------
  {
    key: "csharp",
    label: "C#",
    ext: ["cs", "csx"],
    fence: ["c#", "dotnet"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp)),
  },
  {
    key: "kotlin",
    label: "Kotlin",
    ext: ["kt", "kts"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)),
  },
  {
    key: "scala",
    label: "Scala",
    ext: ["scala", "sbt"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala)),
  },
  {
    key: "objective-c",
    label: "Objective-C",
    ext: ["m"],
    fence: ["objc", "objectivec"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveC)),
  },
  {
    key: "objective-cpp",
    label: "Objective-C++",
    ext: ["mm"],
    fence: ["objc++"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveCpp),
    ),
  },
  {
    key: "dart",
    label: "Dart",
    ext: ["dart"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart)),
  },

  // --- scripting (stream) --------------------------------------------------
  {
    key: "shell",
    label: "Shell",
    ext: ["sh", "bash", "zsh", "ksh"],
    names: [".bashrc", ".zshrc", ".bash_profile", ".profile"],
    fence: ["console", "shellscript"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)),
  },
  {
    key: "powershell",
    label: "PowerShell",
    ext: ["ps1", "psm1", "psd1"],
    fence: ["pwsh"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
    ),
  },
  {
    key: "ruby",
    label: "Ruby",
    ext: ["rb", "rake", "gemspec", "ru"],
    names: ["gemfile", "rakefile"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby)),
  },
  {
    key: "swift",
    label: "Swift",
    ext: ["swift"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)),
  },
  {
    key: "lua",
    label: "Lua",
    ext: ["lua"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua)),
  },
  {
    key: "perl",
    label: "Perl",
    ext: ["pl", "pm"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl)),
  },
  {
    key: "r",
    label: "R",
    ext: ["r"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/r").then((m) => m.r)),
  },
  {
    key: "julia",
    label: "Julia",
    ext: ["jl"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/julia").then((m) => m.julia)),
  },
  {
    key: "groovy",
    label: "Groovy",
    ext: ["groovy", "gradle"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy)),
  },
  {
    key: "coffeescript",
    label: "CoffeeScript",
    ext: ["coffee"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/coffeescript").then((m) => m.coffeeScript),
    ),
  },
  {
    key: "tcl",
    label: "Tcl",
    ext: ["tcl"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/tcl").then((m) => m.tcl)),
  },

  // --- functional (stream) -------------------------------------------------
  {
    key: "haskell",
    label: "Haskell",
    ext: ["hs"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell)),
  },
  {
    key: "ocaml",
    label: "OCaml",
    ext: ["ml", "mli"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.oCaml)),
  },
  {
    key: "fsharp",
    label: "F#",
    ext: ["fs", "fsi", "fsx"],
    fence: ["f#"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.fSharp)),
  },
  {
    key: "clojure",
    label: "Clojure",
    ext: ["clj", "cljs", "cljc", "edn"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure)),
  },
  {
    key: "erlang",
    label: "Erlang",
    ext: ["erl", "hrl"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/erlang").then((m) => m.erlang)),
  },
  {
    key: "scheme",
    label: "Scheme",
    ext: ["scm", "ss"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/scheme").then((m) => m.scheme)),
  },
  {
    key: "lisp",
    label: "Lisp",
    ext: ["lisp", "cl", "el"],
    fence: ["commonlisp", "elisp"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/commonlisp").then((m) => m.commonLisp),
    ),
  },
  {
    key: "elm",
    label: "Elm",
    ext: ["elm"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/elm").then((m) => m.elm)),
  },

  // --- more compiled languages (stream) ------------------------------------
  {
    key: "d",
    label: "D",
    ext: ["d"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/d").then((m) => m.d)),
  },
  {
    key: "crystal",
    label: "Crystal",
    ext: ["cr"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/crystal").then((m) => m.crystal)),
  },
  {
    key: "haxe",
    label: "Haxe",
    ext: ["hx"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/haxe").then((m) => m.haxe)),
  },
  {
    key: "pascal",
    label: "Pascal",
    ext: ["pas"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/pascal").then((m) => m.pascal)),
  },
  {
    key: "fortran",
    label: "Fortran",
    ext: ["f", "f90", "f95", "f03", "for"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/fortran").then((m) => m.fortran)),
  },
  {
    key: "vb",
    label: "Visual Basic",
    ext: ["vb"],
    fence: ["vbnet", "visualbasic"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/vb").then((m) => m.vb)),
  },
  {
    key: "verilog",
    label: "Verilog",
    ext: ["v", "sv"],
    fence: ["systemverilog"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/verilog").then((m) => m.verilog)),
  },
  {
    key: "vhdl",
    label: "VHDL",
    ext: ["vhd", "vhdl"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/vhdl").then((m) => m.vhdl)),
  },
  {
    // No extension of its own on purpose: on disk `.m` is Objective-C here;
    // a ```matlab fence is the one place the name is unambiguous.
    key: "octave",
    label: "Octave",
    fence: ["matlab"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/octave").then((m) => m.octave)),
  },

  // --- data, config and the files around a repo ----------------------------
  {
    key: "yaml",
    label: "YAML",
    ext: ["yml", "yaml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  },
  {
    key: "toml",
    label: "TOML",
    ext: ["toml"],
    names: ["cargo.lock"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)),
  },
  {
    key: "ini",
    label: "Config",
    ext: ["ini", "cfg", "conf", "properties", "env", "editorconfig"],
    names: [
      ".env",
      ".gitignore",
      ".gitattributes",
      ".gitmodules",
      ".gitconfig",
      ".editorconfig",
      ".npmrc",
    ],
    fence: ["dotenv"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
    ),
  },
  {
    key: "dockerfile",
    label: "Dockerfile",
    ext: ["dockerfile"],
    names: ["dockerfile", "containerfile"],
    fence: ["docker"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile),
    ),
  },
  {
    key: "nginx",
    label: "Nginx",
    names: ["nginx.conf"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx)),
  },
  {
    key: "cmake",
    label: "CMake",
    ext: ["cmake"],
    names: ["cmakelists.txt"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake)),
  },
  {
    key: "protobuf",
    label: "Protobuf",
    ext: ["proto"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/protobuf").then((m) => m.protobuf),
    ),
  },
  {
    key: "diff",
    label: "Diff",
    ext: ["diff", "patch"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)),
  },
  {
    key: "latex",
    label: "LaTeX",
    ext: ["tex", "ltx", "sty", "cls"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex)),
  },

  // --- named, but honestly uncolored ---------------------------------------
  // A wrong grammar reads worse than none; these wait for a real one.
  { key: "elixir", label: "Elixir", ext: ["ex", "exs"] },
  { key: "zig", label: "Zig", ext: ["zig"] },
  { key: "graphql", label: "GraphQL", ext: ["graphql", "gql"] },
  { key: "batch", label: "Batch", ext: ["bat", "cmd"] },
  { key: "makefile", label: "Makefile", names: ["makefile", "gnumakefile"] },
];

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------

const BY_EXT = new Map<string, LangSpec>();
const BY_NAME = new Map<string, LangSpec>();
for (const spec of LANGUAGES) {
  for (const e of spec.ext ?? []) BY_EXT.set(e, spec);
  for (const n of spec.names ?? []) BY_NAME.set(n, spec);
}

function languageFor(path: string): LangSpec {
  const itemName = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = BY_NAME.get(itemName);
  if (byName) return byName;
  // The families that suffix themselves: `Dockerfile.dev`, `.env.local`.
  if (itemName.startsWith("dockerfile.")) return BY_NAME.get("dockerfile")!;
  if (itemName.startsWith(".env.")) return BY_NAME.get(".env")!;

  const ext = itemName.includes(".") ? itemName.slice(itemName.lastIndexOf(".") + 1) : "";
  return BY_EXT.get(ext) ?? NO_LANGUAGE;
}

/** The language name shown in the status bar. */
export function languageLabel(path: string): string {
  return languageFor(path).label;
}

/** Whether the file gets the markdown chrome — bar, preview, outline. */
export function isMarkdown(path: string): boolean {
  return languageFor(path).key === "markdown";
}

/**
 * Languages a fenced block inside markdown can ask for — the whole registry,
 * by key, extension or alias. Each one loads only when a block actually names
 * it: opening a README costs nothing until it turns out to contain Rust.
 */
export const fenceLanguages: readonly LanguageDescription[] = LANGUAGES.filter(
  (spec) => spec.load,
).map((spec) =>
  LanguageDescription.of({
    name: spec.key,
    alias: [...(spec.ext ?? []), ...(spec.fence ?? [])],
    load: spec.load!,
  }),
);

/** What the fence header calls the language — `ts` becomes “TypeScript”. */
export function fenceLabel(info: string): string {
  const name = info.trim().toLowerCase();
  if (!name) return "";
  for (const spec of LANGUAGES) {
    if (spec.key === name || spec.ext?.includes(name) || spec.fence?.includes(name)) {
      return spec.label;
    }
  }
  return info;
}

const supportCache = new Map<string, Promise<LanguageSupport | null>>();

/**
 * The file's grammar as `LanguageSupport` — for whoever needs the *parser*
 * (the diff viewer colors lines with it) rather than an editor extension.
 */
export function loadSupport(path: string): Promise<LanguageSupport | null> {
  const spec = languageFor(path);
  const hit = supportCache.get(spec.key);
  if (hit) return hit;
  const pending = spec.load ? spec.load() : Promise.resolve(null);
  supportCache.set(spec.key, pending);
  return pending;
}

/** Loads only the grammar needed by the active document. */
export function loadLanguage(path: string): Promise<Extension | null> {
  return loadSupport(path);
}
