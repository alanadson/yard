/**
 * What one row of the file tree draws, reduced to plain values.
 *
 * The tree re-renders every time `git status` comes back changed, and while an
 * agent is working that is every 1.2 s (`changesStore.scheduleGitRefresh`).
 * The rows are memoized (`TreeRow` in `./index.tsx`): a row that receives the
 * project-wide map re-renders on every refresh, while one that receives only
 * its own letter and dot re-renders when *those* change. So the map is built
 * once per refresh here, and each row gets the projection of it.
 */
import type { CSSProperties } from "react";

import type { GitFileStatus } from "../../lib/ipc";
import { parentDir } from "../../stores/editorStore";

/** `path -> git state`, plus every directory that has some change below it. */
export interface GitMarks {
  byPath: Map<string, GitFileStatus>;
  dirsWithChanges: Set<string>;
}

/** What a row paints for git: the letter (and color), or the folder's dot. */
export interface RowMark {
  status: GitFileStatus | null;
  /** A directory with a change inside and no state of its own, as in VS Code. */
  dot: boolean;
}

export function gitMarks(
  files: readonly { path: string; status: GitFileStatus }[] | undefined,
): GitMarks {
  const byPath = new Map<string, GitFileStatus>();
  const dirsWithChanges = new Set<string>();
  for (const f of files ?? []) {
    byPath.set(f.path, f.status);
    let dir = parentDir(f.path);
    while (dir) {
      dirsWithChanges.add(dir);
      dir = parentDir(dir);
    }
  }
  return { byPath, dirsWithChanges };
}

export function rowMark(marks: GitMarks, path: string, isDir: boolean): RowMark {
  const status = marks.byPath.get(path) ?? null;
  // A state of its own wins over the dot: the letter already says "changed".
  return { status, dot: !status && isDir && marks.dirsWithChanges.has(path) };
}

// ---------------------------------------------------------------------------
// off-screen rows
// ---------------------------------------------------------------------------

/**
 * `content-visibility: auto` on the row's `<li>`: an off-screen row skips
 * style, layout and paint, the same bargain the SCM list (`scm.css`) and the
 * changes list (`changes.css`) already make. A folder can list up to 4000
 * items, and expanding one used to lay out every one of them.
 *
 * The length is `.ftree-row`'s `height` in `CodeEditor/editor.css` (the `<li>`
 * adds nothing around it), so a row that was never on screen reserves exactly
 * what it will take and the scrollbar does not move; `auto` keeps whatever
 * the row last rendered at. `rowView.test.ts` reads the stylesheet to hold the
 * two together.
 */
export const OFFSCREEN_SKIP: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 22px",
};

/**
 * Deepest row that may be skipped. Up to 10 levels a row needs at most 176px
 * (4 + 12 x 10 of indent, 13 + 13 of chevron and icon, three 4px gaps, about
 * 8px of git letter, 6px of right padding; the name shrinks to nothing) and
 * the narrowest host gives it about 220px (the 246px editor rail or the 248px
 * bench, minus their padding and a scrollbar). Deeper than that, the chevron
 * and the icon can spill past the row's right edge, where the host scrolls to
 * them today; the paint containment `content-visibility` brings would clip
 * them instead. So those rows keep painting as they always did.
 */
export const OFFSCREEN_DEPTH_MAX = 10;

/**
 * Whether a row may carry `OFFSCREEN_SKIP`. Never while a name is being typed
 * anywhere in the tree (a rename or a new item): the field's focus halo
 * (`input:focus` in `styles.css`) reaches 2.5px past its own row. Paint
 * containment on that row would clip it; on the neighbours it would make each
 * `<li>` a stacking context painted after the halo, so their hover and
 * selection backgrounds would cover it.
 */
export function skipsOffscreen(depth: number, editingName: boolean): boolean {
  return !editingName && depth <= OFFSCREEN_DEPTH_MAX;
}
