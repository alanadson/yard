/**
 * Shape of the Busca: what a row is, how the typed prefix narrows the hunt,
 * and in what order the sections appear.
 *
 * Kept apart from the component because this is the part with rules — the
 * component only paints what it gets back.
 */
import type { ReactNode } from "react";

export type EntryKind =
  | "action"
  | "terminal"
  | "group"
  | "project"
  | "note"
  | "memo"
  /** A frame drawn on the canvas (§5.4) — not a workspace group. */
  | "frame"
  /** A file pinned to the canvas as a card (§52). */
  | "media"
  /** A fichário — several notes in one node (§13). */
  | "binder"
  /** A file-tree card on the canvas (§14). */
  | "tree"
  | "portal"
  | "url"
  | "file"
  | "prompt"
  | "task";

export interface PaletteEntry {
  id: string;
  kind: EntryKind;
  title: string;
  /** Dimmed line under the title — where this thing lives. */
  subtitle?: string;
  /** Words the search should see but the row does not show (aliases, paths). */
  keywords?: string[];
  /** Shortcut painted on the right (`Ctrl+T`). */
  hint?: string;
  icon?: ReactNode;
  /**
   * Nudge on top of the score. Things in the active group sit above the same
   * thing three projects away — with nothing typed, this **is** the order.
   */
  weight?: number;
  /** Runs on Enter. The Busca closes first, so this may open a modal. */
  run: () => void;
}

export interface Scope {
  prefix: string;
  kinds: readonly EntryKind[];
  /** Shown in the footer legend and in the chip once the prefix is typed. */
  label: string;
}

/**
 * A prefix only counts as the first character. `/src/lib` is a path filter,
 * not a path — that is the point: whoever types a path is looking for a file.
 */
export const SCOPES: readonly Scope[] = [
  { prefix: ">", kinds: ["action"], label: "ações" },
  { prefix: "@", kinds: ["terminal"], label: "agentes" },
  {
    prefix: "#",
    kinds: ["note", "portal", "frame", "media", "binder", "tree", "url"],
    label: "canvas",
  },
  { prefix: "/", kinds: ["file"], label: "arquivos" },
];

export interface ParsedQuery {
  scope: Scope | null;
  /** What is left to search for once the prefix is taken off. */
  text: string;
}

export function parseQuery(raw: string): ParsedQuery {
  const value = raw.replace(/^\s+/, "");
  const scope = SCOPES.find((s) => value.startsWith(s.prefix)) ?? null;
  return {
    scope,
    text: (scope ? value.slice(scope.prefix.length) : value).trim(),
  };
}

/** Section order and headings, top to bottom. */
export const KIND_LABEL: Record<EntryKind, string> = {
  action: "Ações",
  terminal: "Agentes e terminais",
  group: "Grupos e andares",
  project: "Projetos",
  note: "Notas do canvas",
  memo: "Anotações",
  frame: "Grupos do canvas",
  media: "Arquivos no canvas",
  binder: "Fichários",
  tree: "Árvores de arquivos",
  portal: "Portais",
  url: "Endereços anunciados",
  file: "Arquivos",
  prompt: "Prompts",
  task: "Tarefas",
};

const KIND_ORDER: readonly EntryKind[] = [
  "terminal",
  "url",
  "action",
  "file",
  "note",
  "memo",
  "portal",
  "frame",
  "media",
  "binder",
  "tree",
  "group",
  "project",
  "prompt",
  "task",
];

export interface PaletteSection {
  kind: EntryKind;
  label: string;
  entries: PaletteEntry[];
}

/**
 * Groups the ranked rows into sections **without reordering them across
 * sections by score**: the list is already ranked, so a section is placed by
 * where its best row landed. A perfect match must never be pushed below a
 * section that only fuzzy-matched, however high that section normally sits.
 */
export function sectionsOf(entries: readonly PaletteEntry[]): PaletteSection[] {
  const byKind = new Map<EntryKind, PaletteEntry[]>();
  for (const entry of entries) {
    const list = byKind.get(entry.kind);
    if (list) list.push(entry);
    else byKind.set(entry.kind, [entry]);
  }
  return [...byKind.entries()].map(([kind, rows]) => ({
    kind,
    label: KIND_LABEL[kind],
    entries: rows,
  }));
}

/**
 * The order rows take when nothing is typed. Then — and only then — the fixed
 * section order applies: an empty box is a menu, not a result list.
 */
export function restingOrder(entries: readonly PaletteEntry[]): PaletteEntry[] {
  const rank = new Map(KIND_ORDER.map((kind, index) => [kind, index]));
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (rank.get(a.entry.kind) ?? 99) - (rank.get(b.entry.kind) ?? 99) ||
        (b.entry.weight ?? 0) - (a.entry.weight ?? 0) ||
        a.index - b.index,
    )
    .map((h) => h.entry);
}

/** Everything the ranking is allowed to read on a row. */
export function fieldsOf(entry: PaletteEntry): string[] {
  const fields = [entry.title];
  if (entry.subtitle) fields.push(entry.subtitle);
  if (entry.keywords) fields.push(...entry.keywords);
  return fields;
}
