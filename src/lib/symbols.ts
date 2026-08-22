/**
 * Code symbols for the editor's outline — functions, classes, types, the
 * things a person scrolls a file looking for.
 *
 * Markdown files get their outline from the real parser (`mddoc.ts`); code
 * gets this: line-based patterns per language family. Deliberately **not** a
 * parser — a parser per language is an LSP, and the outline's job is humbler:
 * land the eye near the right line. A pattern that misses an exotic
 * declaration costs one missing row; a parser that is wrong costs a wrong
 * tree. Level comes from indentation, which is what the eye uses anyway.
 */

export interface CodeSymbol {
  /** Indentation depth, 1-based — the outline's own scale. */
  level: number;
  /** What the row shows. */
  text: string;
  /** 0-based source line, the same contract the markdown outline uses. */
  line: number;
}

/** Past this nobody is reading an outline, they are searching. */
const MAX_SYMBOLS = 500;

interface Pattern {
  re: RegExp;
  /** Which capture group holds the name (default 1). */
  group?: number;
  /** Prefix drawn before the name (`class`, `fn`…) — keeps rows scannable. */
  tag?: string;
  /** Only matches at column 0 — for indentation-scoped formats (YAML). */
  topLevel?: boolean;
}

/** `^[ \t]*` is implicit: every pattern is matched against the trimmed line. */
const FAMILIES: { ext: string[]; patterns: Pattern[] }[] = [
  {
    ext: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
    patterns: [
      { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
      { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, tag: "class" },
      { re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, tag: "interface" },
      { re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, tag: "type" },
      { re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, tag: "enum" },
      // `const foo = (args) =>`, `const foo = async function`, `const foo = useMemo(`…
      {
        re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)\s*(?::[^=]+)?=>|function\b|[A-Za-z_$][\w$]*\s*=>)/,
      },
      // Class members: `foo(args) {`, `async foo(args) {`, `get foo() {` —
      // indented, so the level already files them under their class.
      {
        re: /^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+)*(?:async\s+)?(?:get\s+|set\s+)?\*?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\([^)]*\)?\s*(?::[^{;]+)?\{\s*$/,
      },
    ],
  },
  {
    ext: ["py", "pyi", "pyw"],
    patterns: [
      { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
      { re: /^class\s+([A-Za-z_]\w*)/, tag: "class" },
    ],
  },
  {
    ext: ["rs"],
    patterns: [
      { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/ },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, tag: "struct" },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, tag: "enum" },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, tag: "trait" },
      { re: /^impl(?:\s*<[^>]*>)?\s+(?:[A-Za-z_][\w:]*(?:\s*<[^>]*>)?\s+for\s+)?([A-Za-z_][\w:]*)/, tag: "impl" },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, tag: "mod" },
      { re: /^macro_rules!\s+([A-Za-z_]\w*)/, tag: "macro" },
    ],
  },
  {
    ext: ["go"],
    patterns: [
      { re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/ },
      { re: /^type\s+([A-Za-z_]\w*)/, tag: "type" },
    ],
  },
  {
    ext: ["java", "kt", "kts", "cs", "scala", "dart"],
    patterns: [
      {
        re: /^(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|sealed\s+|static\s+|open\s+|data\s+|partial\s+)*(?:class|interface|enum|record|object|trait|struct)\s+([A-Za-z_]\w*)/,
        tag: "class",
      },
      // Method-ish: `Type name(args) {` — indented under a class.
      {
        re: /^(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|override\s+|virtual\s+|async\s+|suspend\s+|fun\s+)+\*?(?:[\w<>[\],.\s?]+\s+)?([A-Za-z_]\w*)\s*\([^)]*\)?/,
      },
    ],
  },
  {
    ext: ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx"],
    patterns: [
      { re: /^(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)/, tag: "struct" },
      { re: /^#define\s+([A-Za-z_]\w*)/, tag: "define" },
      // `ret name(args) {` at little indentation — the classic C function.
      { re: /^(?:[A-Za-z_][\w:<>*&\s]*\s+)?\*?([A-Za-z_][\w:]*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/ },
    ],
  },
  {
    ext: ["php"],
    patterns: [
      { re: /^(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, tag: "class" },
      { re: /^(?:public\s+|private\s+|protected\s+|static\s+)*function\s+&?([A-Za-z_]\w*)/ },
    ],
  },
  {
    ext: ["rb", "rake"],
    patterns: [
      { re: /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/ },
      { re: /^(?:class|module)\s+([A-Z]\w*)/, tag: "class" },
    ],
  },
  {
    ext: ["sh", "bash", "zsh"],
    patterns: [
      { re: /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/ },
      { re: /^function\s+([A-Za-z_][\w-]*)/ },
    ],
  },
  {
    ext: ["ps1", "psm1"],
    patterns: [{ re: /^function\s+([A-Za-z_][\w-]*)/ }],
  },
  {
    ext: ["lua"],
    patterns: [{ re: /^(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/ }],
  },
  {
    ext: ["css", "scss", "less"],
    patterns: [
      // Only named blocks worth jumping to: no listing every selector.
      { re: /^@(?:media|keyframes|layer|supports|font-face)\s*([^{]*)/, group: 1, tag: "@" },
    ],
  },
  {
    ext: ["yml", "yaml"],
    // Top-level keys only (no indentation): the sections of the file.
    patterns: [{ re: /^([\w][\w./-]*):(?:\s|$)/, topLevel: true }],
  },
  {
    ext: ["toml", "ini", "cfg", "conf"],
    patterns: [{ re: /^\[+([^\]]+)\]+/ }],
  },
  {
    ext: ["sql"],
    patterns: [
      {
        re: /^create\s+(?:or\s+replace\s+)?(?:table|view|index|function|procedure|trigger|schema)\s+(?:if\s+not\s+exists\s+)?["'`[]?([\w.]+)/i,
        tag: "create",
      },
    ],
  },
];

const BY_EXT = new Map<string, Pattern[]>();
for (const family of FAMILIES) {
  for (const ext of family.ext) BY_EXT.set(ext, family.patterns);
}

/** Words that pass the method-ish patterns but declare nothing. */
const NOISE = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "new",
  "await", "typeof", "delete", "void", "yield", "constructor", "super",
  "sizeof", "defined",
]);

/** Indentation → outline level (tabs count as one step). */
function levelOf(line: string): number {
  let spaces = 0;
  for (const ch of line) {
    if (ch === " ") spaces += 1;
    else if (ch === "\t") spaces += 4;
    else break;
  }
  return Math.min(1 + Math.floor(spaces / 4), 4);
}

/**
 * The file's symbols, top to bottom. Empty when the language has no patterns
 * (better no outline than a wrong one) — the caller hides the rail then.
 */
export function symbolsOf(path: string, text: string): CodeSymbol[] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const patterns = BY_EXT.get(ext);
  if (!patterns) return [];

  const out: CodeSymbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#!") || trimmed.startsWith("*")) {
      continue;
    }
    for (const p of patterns) {
      if (p.topLevel && trimmed !== raw) continue;
      const m = p.re.exec(trimmed);
      if (!m) continue;
      const symbol = (m[p.group ?? 1] ?? "").trim();
      if (!symbol || NOISE.has(symbol)) break;
      out.push({
        level: levelOf(raw),
        text: p.tag ? `${p.tag} ${symbol}` : symbol,
        line: i,
      });
      break;
    }
  }
  return out;
}

/** Does this file get a symbols outline at all? (decides showing the button) */
export function hasSymbolSupport(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return BY_EXT.has(ext);
}
