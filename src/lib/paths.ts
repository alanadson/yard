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

/** A Windows root is one with a drive letter or a UNC prefix — not one that
 *  merely happens to contain a backslash. */
const WINDOWS_ROOT = /^(?:[A-Za-z]:|\\\\)/;

/**
 * Absolute path in the shape the OS expects, from a root plus a
 * project-relative path.
 *
 * Everything above this line speaks git's `/`. The moment a path leaves for a
 * shell — `reveal_path`, and nothing else today — it needs the native
 * separator. Three call sites were assembling `${root}\${rel.replaceAll(…)}`
 * by hand, which is both a repetition and the one spot that would break the
 * day this app leaves Windows.
 *
 * The platform is read from the **shape** of the root, not from whether it
 * contains a backslash. `git worktree list --porcelain` reports Windows paths
 * with forward slashes (`C:/proj/.yard/floors/x`), and the old test —
 * "contains a `\`" — classified those as POSIX: `reveal_path` then handed
 * `explorer.exe /select,C:/proj/src/a.ts` to a shell that does not select
 * anything with that spelling. A drive letter is a drive letter regardless of
 * which slash follows it, so the whole path is normalized to `\` here.
 */
export function toOsPath(root: string, relative: string): string {
  // An already-rooted path is relative to nothing. The live overlay lists
  // files the agent touched outside the project (its memory, a screenshot in
  // %TEMP%), and gluing them to the root produced `C:\proj\C:\Users\…`, which
  // is not a path anywhere.
  if (WINDOWS_ROOT.test(relative)) return relative.replaceAll("/", "\\");
  if (relative.startsWith("/")) return relative;

  const windows = WINDOWS_ROOT.test(root);
  if (!windows) {
    const base = root.replace(/\/+$/, "");
    // A backslash is a legal file-name character on POSIX: only `/` separates.
    return relative ? `${base}/${relative}` : base;
  }
  const base = root.replace(/[\\/]+$/, "").replaceAll("/", "\\");
  const rel = relative.replaceAll("/", "\\");
  return rel ? `${base}\\${rel}` : base;
}
