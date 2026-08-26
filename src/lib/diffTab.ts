/**
 * A comparison as a document — the diff of one file opened as a **tab beside
 * the CLIs**, the way VS Code's diff editor opens from source control.
 *
 * The tab is an `OpenDoc` with a `diff` descriptor; this module is the part
 * of it that is pure: which comparison it is (`DiffSpec`), the word the tab
 * shows after the file name, and an id that cannot collide with the file's
 * own tab nor with the other side of the same file. The fetch and the
 * drawing live in `components/CodeEditor/DiffTab.tsx`.
 */
// i18n-scan: tables — the side words are translated by `diffSuffix`, where they are read.
import { t } from "./i18n";
import type { ScmDiffSide } from "./ipc";
import { rootedPathKey } from "./roots";

/**
 * What a diff tab compares.
 *
 * - `tree`: the working tree against the index (`worktree` — "Alterações"),
 *   the index against `HEAD` (`index` — "Preparado"), or the disk against
 *   `HEAD` (`head`). `origPath` is the name the file had before a rename, or
 *   `null`; the backend needs it to find the old side.
 * - `commit`: what one commit did to the file. Immutable, so the tab never
 *   needs to reload.
 */
export type DiffSpec =
  | { source: "tree"; side: ScmDiffSide; origPath: string | null }
  | { source: "commit"; hash: string };

const SIDE_WORDS: Record<ScmDiffSide, string> = {
  worktree: "Alterações",
  index: "Preparado",
  head: "HEAD",
};

/**
 * The word after the file name on the tab — the same word the Source Control
 * tab uses for the group the row came from, so the tab reads as "that file,
 * from that group". A commit is named by its short hash, as everywhere else.
 */
export function diffSuffix(spec: DiffSpec): string {
  return spec.source === "commit" ? spec.hash.slice(0, 7) : t(SIDE_WORDS[spec.side]);
}

/**
 * The NUL byte — the one character no file system lets into a path, and the
 * same separator `rootedPathKey` puts between root and path. Spelled out
 * rather than escaped so it is visible for what it is.
 */
const NUL = String.fromCharCode(0);

/**
 * The tab's id. It starts with the file's own key (root + path) and adds a
 * third segment the file never has — so a comparison and the file are two
 * tabs, and so are its two sides.
 */
export function diffDocId(root: string, path: string, spec: DiffSpec): string {
  const which = spec.source === "commit" ? `commit:${spec.hash}` : spec.side;
  return `${rootedPathKey(root, path)}${NUL}diff:${which}`;
}

const SIDES: ScmDiffSide[] = ["worktree", "index", "head"];

/** Reads a stored descriptor back; `null` for anything this module did not write. */
export function parseDiffSpec(raw: unknown): DiffSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.source === "commit") {
    return typeof d.hash === "string" && d.hash.length > 0 ? { source: "commit", hash: d.hash } : null;
  }
  if (d.source === "tree") {
    if (!SIDES.includes(d.side as ScmDiffSide)) return null;
    return {
      source: "tree",
      side: d.side as ScmDiffSide,
      origPath: typeof d.origPath === "string" ? d.origPath : null,
    };
  }
  return null;
}
