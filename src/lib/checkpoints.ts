/** Checkpoints belong to the task in its actual working directory. */
import { normalizeFloor } from "./floors";
import { rootKey } from "./roots";
import { t } from "./i18n";

export interface CheckpointScope {
  root: string;
  taskId: string;
  taskLabel: string;
}

export interface Checkpoint extends CheckpointScope {
  id: string;
  label: string;
  createdAt: number;
  fileCount: number;
  bytes: number;
  gitState: string;
}

export interface CheckpointPreview {
  token: string;
  blockedReason: string | null;
  files: { path: string; status: "added" | "modified" | "deleted"; beforeBytes: number; afterBytes: number }[];
}

export interface CheckpointComparison {
  before: string | null;
  after: string | null;
  binary: boolean;
}

export function checkpointChangeLabel(status: "added" | "modified" | "deleted"): string {
  return t({ added: "Será removido", modified: "Será restaurado", deleted: "Será recriado" }[status]);
}

export function restoreBlockReason(
  root: string,
  docs: readonly { root: string; text: string; saved: string; crlf: boolean; savedCrlf: boolean }[],
  busy: boolean,
): string | null {
  if (docs.some((doc) => checkpointRootsOverlap(root, doc.root) && (doc.text !== doc.saved || doc.crlf !== doc.savedCrlf))) {
    return t("Salve ou descarte os arquivos abertos desta pasta antes de restaurar.");
  }
  if (busy) return t("Aguarde os agentes desta pasta terminarem antes de restaurar.");
  return null;
}

export function checkpointRootsOverlap(a: string, b: string): boolean {
  const normalize = (value: string) => rootKey(value).replace(/^\/\/\?\/unc\//, "//").replace(/^\/\/\?\//, "");
  const left = normalize(a);
  const right = normalize(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function checkpointScope(
  terminal: { id: string; cwd: string; groupId: string; title?: string | null },
  group?: { id: string; name: string; layoutJson: string },
  task?: { id: string; text: string },
): CheckpointScope {
  if (task) return { root: terminal.cwd, taskId: task.id, taskLabel: task.text };
  let floor;
  try { floor = normalizeFloor(JSON.parse(group?.layoutJson || "{}").floor); }
  catch { /* A damaged saved layout keeps the terminal as its task identity. */ }
  return { root: terminal.cwd, taskId: floor?.task?.id ?? terminal.id, taskLabel: floor?.task?.prompt ?? terminal.title ?? terminal.id };
}
