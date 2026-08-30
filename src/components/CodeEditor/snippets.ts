/**
 * The handful of shapes worth not typing.
 *
 * Small on purpose, and not configurable on purpose. A snippet library people
 * can edit becomes a second thing to maintain and a first thing to forget;
 * what earns a place here is the shape you write ten times a day and get one
 * brace wrong on the tenth.
 *
 * They sit **under** the language server and the grammar in the completion
 * list, and that ordering is the point: a server's suggestion is about *this
 * project*, a snippet is only about the language, and the project always
 * knows better.
 */
import { snippetCompletion, type Completion } from "@codemirror/autocomplete";

export interface SnippetRow {
  /** Typed to reach it. */
  label: string;
  /** The line beside it in the list, saying what it writes. */
  detail: string;
  /** CodeMirror's template syntax: `${name}` is a hole to tab through. */
  template: string;
}

/** i18n-scan: tables. A snippet's `detail` is a name, not a sentence. */
export const SNIPPETS: Record<string, SnippetRow[]> = {
  js: [
    { label: "fn", detail: "function", template: "function ${name}(${args}) {\n\t${}\n}" },
    { label: "afn", detail: "arrow function", template: "const ${name} = (${args}) => {\n\t${}\n}" },
    { label: "async", detail: "async function", template: "async function ${name}(${args}) {\n\t${}\n}" },
    { label: "log", detail: "console.log", template: "console.log(${})" },
    { label: "if", detail: "if", template: "if (${cond}) {\n\t${}\n}" },
    { label: "for", detail: "for of", template: "for (const ${item} of ${list}) {\n\t${}\n}" },
    { label: "try", detail: "try/catch", template: "try {\n\t${}\n} catch (e) {\n\t${}\n}" },
    { label: "cls", detail: "class", template: "class ${Name} {\n\t${}\n}" },
    { label: "int", detail: "interface", template: "interface ${Name} {\n\t${}\n}" },
    { label: "test", detail: "describe/it", template: 'describe("${name}", () => {\n\tit("${does}", () => {\n\t\t${}\n\t});\n});' },
  ],
  rs: [
    { label: "fn", detail: "fn", template: "fn ${name}(${args}) {\n\t${}\n}" },
    { label: "pfn", detail: "pub fn", template: "pub fn ${name}(${args}) -> ${T} {\n\t${}\n}" },
    { label: "test", detail: "#[test]", template: "#[test]\nfn ${name}() {\n\t${}\n}" },
    { label: "mod", detail: "mod tests", template: "#[cfg(test)]\nmod tests {\n\tuse super::*;\n\n\t${}\n}" },
    { label: "impl", detail: "impl", template: "impl ${Type} {\n\t${}\n}" },
    { label: "match", detail: "match", template: "match ${value} {\n\t${pattern} => ${},\n}" },
    { label: "st", detail: "struct", template: "struct ${Name} {\n\t${}\n}" },
    { label: "iflet", detail: "if let", template: "if let ${Some(x)} = ${value} {\n\t${}\n}" },
  ],
  py: [
    { label: "def", detail: "def", template: "def ${name}(${args}):\n\t${}" },
    { label: "cls", detail: "class", template: "class ${Name}:\n\tdef __init__(self${args}):\n\t\t${}" },
    { label: "main", detail: "if __main__", template: 'if __name__ == "__main__":\n\t${}' },
    { label: "for", detail: "for", template: "for ${item} in ${items}:\n\t${}" },
    { label: "try", detail: "try/except", template: "try:\n\t${}\nexcept ${Exception} as e:\n\t${}" },
  ],
  go: [
    { label: "fn", detail: "func", template: "func ${name}(${args}) ${T} {\n\t${}\n}" },
    { label: "iferr", detail: "if err != nil", template: "if err != nil {\n\treturn ${err}\n}" },
    { label: "for", detail: "for range", template: "for ${i}, ${v} := range ${items} {\n\t${}\n}" },
    { label: "st", detail: "struct", template: "type ${Name} struct {\n\t${}\n}" },
    { label: "test", detail: "func Test", template: "func Test${Name}(t *testing.T) {\n\t${}\n}" },
  ],
};

/** Which family a path belongs to, or `null` for a language with no table. */
const FAMILY: Record<string, string> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  rs: "rs",
  py: "py",
  pyi: "py",
  go: "go",
};

/** The rows for a path. Empty for a language with no table, markdown included. */
export function snippetsFor(path: string): SnippetRow[] {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [];
  const family = FAMILY[name.slice(dot + 1).toLowerCase()];
  return family ? SNIPPETS[family] : [];
}

/**
 * The same rows as CodeMirror completions. `boost` is negative so a server's
 * suggestion, and the buffer's own words, both come first.
 */
export function snippetCompletions(path: string): Completion[] {
  return snippetsFor(path).map((row) =>
    snippetCompletion(row.template, {
      label: row.label,
      detail: row.detail,
      type: "keyword",
      boost: -20,
    }),
  );
}
