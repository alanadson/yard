/**
 * The outline, read from a language server.
 *
 * `lib/symbols.ts` stays the floor: regexes over lines, working in fifty
 * languages with nothing installed. What it cannot know is that `push`
 * belongs to `Fila` rather than to the indentation it shares with it. A
 * server knows, so when one is answering for this file, its reply wins.
 *
 * `textDocument/documentSymbol` has two shapes on the wire, the nested
 * `DocumentSymbol[]` and the flat `SymbolInformation[]` older servers still
 * send, and both arrive here as bare JSON from a process this repository
 * does not control. Nothing below trusts a field before reading it: a single
 * malformed entry costs one row, never the outline.
 */
import type { CodeSymbol } from "../symbols";

/** The same ceiling the regex outline uses: past this nobody is reading. */
const MAX_SYMBOLS = 500;

/**
 * Kinds worth naming in the row. The rest read better bare, a function's
 * name already looks like a function, and "function " on four hundred rows
 * is four hundred rows of the same word.
 */
const KIND_TAG: Record<number, string> = {
  2: "module",
  3: "namespace",
  5: "class",
  10: "enum",
  11: "interface",
  23: "struct",
  26: "type",
};

interface Position {
  line: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The 0-based line of an LSP range, or `null` when there is not one to read. */
function lineOf(range: unknown): number | null {
  if (!isRecord(range)) return null;
  const start = range.start;
  if (!isRecord(start)) return null;
  const line = (start as unknown as Position).line;
  return Number.isInteger(line) && line >= 0 ? line : null;
}

function label(name: string, kind: unknown): string {
  const tag = typeof kind === "number" ? KIND_TAG[kind] : undefined;
  return tag ? `${tag} ${name}` : name;
}

/**
 * The server's answer as the outline's own rows. Handles both wire shapes;
 * anything it cannot place is skipped.
 */
export function flattenSymbols(reply: unknown): CodeSymbol[] {
  if (!Array.isArray(reply)) return [];
  const out: CodeSymbol[] = [];

  const walk = (nodes: unknown[], level: number) => {
    for (const node of nodes) {
      if (out.length >= MAX_SYMBOLS) return;
      if (!isRecord(node)) continue;
      const name = node.name;
      if (typeof name !== "string" || !name) continue;

      // Nested shape first: `range` is the symbol's own extent. The flat
      // shape hides the same information one level down, in `location`.
      const own = lineOf(node.range);
      const located = isRecord(node.location) ? lineOf(node.location.range) : null;
      const line = own ?? located;
      if (line === null) continue;

      // A flat reply has no nesting to read, only a container name, one
      // level of it, which is all `SymbolInformation` ever promised.
      const depth =
        own === null && typeof node.containerName === "string" && node.containerName
          ? 2
          : level;

      out.push({ level: depth, text: label(name, node.kind), line });
      if (Array.isArray(node.children)) walk(node.children, level + 1);
    }
  };

  walk(reply, 1);
  // Servers are free to answer in any order, and the rail is read top to
  // bottom. A stable sort keeps a parent above the children it just pushed.
  return out.sort((a, b) => a.line - b.line).slice(0, MAX_SYMBOLS);
}
