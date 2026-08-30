/**
 * A symbol, anywhere in the project.
 *
 * `Ctrl+P` finds a *file* by name from an index this app builds itself, which
 * is the right tool right up to the moment you want `parseStoredDocs` and do
 * not remember that it lives in `editorStore.ts`. Remembering which file a
 * function is in is precisely what you were asking the editor for.
 *
 * `workspace/symbol` has two shapes on the wire. `SymbolInformation` carries
 * a full location. The newer `WorkspaceSymbol` may carry a bare uri, because
 * resolving the range costs the server something it would rather not spend
 * until a row is actually picked, so a row with no range still gets offered,
 * pointing at the top of the right file.
 */
import { displayPath } from "./problems";

export interface WorkspaceSymbolRow {
  name: string;
  /** The LSP `SymbolKind`, for the glyph on the row. */
  kind: number;
  /** Relative to the project root, or absolute when it lives outside it. */
  path: string;
  /** 1-based; `1` when the server has not resolved a range yet. */
  line: number;
  /** The class or module the symbol belongs to, when the server said. */
  container?: string;
}

/** A list a person can still read down. */
export const MAX_WORKSPACE_SYMBOLS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The reply as rows for the palette. */
export function readWorkspaceSymbols(reply: unknown, root: string): WorkspaceSymbolRow[] {
  if (!Array.isArray(reply)) return [];
  const rows: WorkspaceSymbolRow[] = [];
  for (const entry of reply) {
    if (rows.length >= MAX_WORKSPACE_SYMBOLS) break;
    if (!isRecord(entry)) continue;
    const name = entry.name;
    if (typeof name !== "string" || !name) continue;
    const location = entry.location;
    if (!isRecord(location) || typeof location.uri !== "string") continue;

    const range = location.range;
    const start = isRecord(range) ? range.start : null;
    const line =
      isRecord(start) && Number.isInteger(start.line) ? (start.line as number) + 1 : 1;

    rows.push({
      name,
      kind: typeof entry.kind === "number" ? entry.kind : 0,
      path: displayPath(root, location.uri),
      line,
      ...(typeof entry.containerName === "string" && entry.containerName
        ? { container: entry.containerName }
        : {}),
    });
  }
  return rows;
}
