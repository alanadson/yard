/**
 * Project-relative paths, as the app shows them.
 *
 * Everything the backend sends uses `/` (git's convention), so a single
 * `lastIndexOf` is the whole rule. It lived in three copies — the files
 * panel, the diff viewer and the live overlay — each rebuilding the same
 * dir/base split with slightly different variable names.
 */

export interface SplitPath {
  /** Directory part, trailing slash included. Empty at the repo root. */
  dir: string;
  /** File name. */
  base: string;
}

export function splitPath(path: string): SplitPath {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { dir: "", base: path }
    : { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

/** Just the file name — for rails and lists too narrow for the directory. */
export function fileName(path: string): string {
  return splitPath(path).base;
}
