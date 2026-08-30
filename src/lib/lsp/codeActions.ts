/**
 * Quick fixes: the other half of a diagnostic.
 *
 * The editor has been able to *show* what a server thinks is wrong since the
 * day it learned to speak LSP, and been unable to do anything about it. This
 * is `textDocument/codeAction`, "there is an unused import" becoming "press
 * Ctrl+. and it is gone".
 *
 * The reply is a mixed list: modern `CodeAction` objects, bare `Command`s
 * from older servers, actions the server has already ruled out, and actions
 * whose work happens server-side. Only one of those can be honoured here: an
 * action carrying an `edit`, which is a `WorkspaceEdit` this editor knows how
 * to apply (`edits.ts`).
 *
 * A command-only action is dropped rather than shown. Running one means
 * `workspace/executeCommand`, whose result comes back as a
 * `workspace/applyEdit` **request** from the server, and the client in use
 * here answers notifications, not requests. An entry that looks like a fix
 * and does nothing is worse than a shorter menu.
 */

export interface CodeActionRow {
  title: string;
  /** The LSP kind, when the server named one (`quickfix`, `refactor.extract`…). */
  kind?: string;
  /** The `WorkspaceEdit` to apply, the reason this row exists at all. */
  edit: unknown;
}

/** A menu, not a list. */
export const MAX_ACTIONS = 12;

/**
 * Rank by family. Ctrl+. is pressed on a squiggle far more often than on a
 * decision to restructure something, so a fix outranks a refactor, and a
 * whole-file source action comes last.
 */
function rank(kind: string | undefined, preferred: boolean): number {
  if (preferred) return 0;
  if (!kind) return 3;
  if (kind.startsWith("quickfix")) return 1;
  if (kind.startsWith("refactor")) return 2;
  if (kind.startsWith("source")) return 4;
  return 3;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The reply as menu rows, best first. */
export function readActions(reply: unknown): CodeActionRow[] {
  if (!Array.isArray(reply)) return [];
  const rows: { row: CodeActionRow; rank: number; at: number }[] = [];
  for (const entry of reply) {
    if (!isRecord(entry)) continue;
    const title = entry.title;
    if (typeof title !== "string" || !title) continue;
    // The server said this one is not available where the caret is.
    if (entry.disabled) continue;
    if (!entry.edit) continue;
    const kind = typeof entry.kind === "string" ? entry.kind : undefined;
    rows.push({
      row: { title, ...(kind ? { kind } : {}), edit: entry.edit },
      rank: rank(kind, entry.isPreferred === true),
      at: rows.length,
    });
  }
  // Stable inside a family: the server's own order is a judgement too.
  rows.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return rows.slice(0, MAX_ACTIONS).map((r) => r.row);
}
