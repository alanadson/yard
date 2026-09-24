/**
 * What tells an open diff that it may be stale.
 *
 * A live diff tab asks `git` for its comparison on its own (no cache), so the
 * question "did anything that can change *this* file's diff happen?" has to be
 * answerable per file, not per project. The store records, per project, the
 * tick at which each path was last reported changed; a file's revision is the
 * newest tick among itself, the folders that contain it and the project-wide
 * epoch (a change that named no path).
 */
import type { ChangedFile, ChangesSummary } from "./ipc";
import { rootKey } from "./roots";

export interface ContentRevisions {
  /** Tick of the last change that named no path: every file moved with it. */
  epoch: number;
  /** Normalized path (file or folder) -> tick of the last change naming it. */
  byPath: Record<string, number>;
}

/** Distinct paths remembered per project before they are traded for an epoch. */
export const CONTENT_REVISION_CAP = 2000;

/**
 * Records a change at `tick`; without `paths`, every file of the project
 * changed. Past `cap` remembered paths the per-path ticks are dropped and the
 * epoch takes the tick instead: every open diff re-reads once, none misses a
 * change.
 */
export function markContentChanged(
  revisions: ContentRevisions | undefined,
  tick: number,
  paths?: readonly string[],
  cap = CONTENT_REVISION_CAP,
): ContentRevisions {
  if (!paths) return { epoch: tick, byPath: {} };
  const byPath = { ...revisions?.byPath };
  for (const path of paths) byPath[rootKey(path)] = tick;
  if (Object.keys(byPath).length > cap) return { epoch: tick, byPath: {} };
  return { epoch: revisions?.epoch ?? 0, byPath };
}

/**
 * The revision an open diff of `path` (renamed from `origPath`) follows. A
 * folder counts for the files under it (the same prefix rule the diff cache
 * is pruned by); the empty path names nothing.
 */
export function contentRevisionOf(
  revisions: ContentRevisions | undefined,
  path: string,
  origPath?: string | null,
): number {
  if (!revisions) return 0;
  let revision = revisions.epoch;
  for (const file of [path, origPath]) {
    if (!file) continue;
    for (let key = rootKey(file); key; key = key.slice(0, Math.max(0, key.lastIndexOf("/")))) {
      revision = Math.max(revision, revisions.byPath[key] ?? 0);
    }
  }
  return revision;
}

/**
 * Everything `git status` says about one file: both sides and the conflict
 * pair, not only the summarised `status` (staging a hunk of a modified file
 * moves `.M` to `MM` and changes nothing else).
 */
export function fileFingerprint(f: ChangedFile): string {
  return `${f.path}\u0000${f.origPath ?? ""}\u0000${f.status}\u0000${f.index}\u0000${f.worktree}\u0000${f.conflict ?? ""}\u0000${f.additions ?? ""}\u0000${f.deletions ?? ""}\u0000${f.binary}`;
}

/**
 * Normalized name -> fingerprints of every entry naming it, as its path or as
 * the path it was renamed from. Built once per summary object.
 */
const entriesBySummary = new WeakMap<ChangesSummary, Map<string, string>>();

function entriesByName(summary: ChangesSummary): Map<string, string> {
  let entries = entriesBySummary.get(summary);
  if (entries) return entries;
  entries = new Map();
  for (const f of summary.files) {
    const print = fileFingerprint(f);
    for (const name of [f.path, f.origPath]) {
      if (!name) continue;
      const key = rootKey(name);
      const prior = entries.get(key);
      entries.set(key, prior === undefined ? print : `${prior}\u0001${print}`);
    }
  }
  entriesBySummary.set(summary, entries);
  return entries;
}

/**
 * The names whose entry differs between two summaries, or `undefined` when
 * every file may have changed: no earlier summary to compare with, or a
 * different branch (or repository) whose HEAD sits under every file.
 */
export function changedEntryPaths(
  previous: ChangesSummary | undefined,
  next: ChangesSummary,
): string[] | undefined {
  if (!previous || previous.isRepo !== next.isRepo || previous.branch !== next.branch) {
    return undefined;
  }
  const before = entriesByName(previous);
  const after = entriesByName(next);
  const changed: string[] = [];
  for (const [name, print] of after) if (before.get(name) !== print) changed.push(name);
  for (const name of before.keys()) if (!after.has(name)) changed.push(name);
  return changed;
}

/**
 * What the summary says about one file (renamed from `origPath`), as a
 * primitive an open diff can subscribe to: it changes when this file's entry
 * does, never for another's.
 */
export function entrySignature(
  summary: ChangesSummary | undefined,
  path: string,
  origPath?: string | null,
): string {
  if (!summary) return "";
  const entries = entriesByName(summary);
  const of = (name: string | null | undefined) => (name ? entries.get(rootKey(name)) ?? "" : "");
  return `${of(path)}\u0002${of(origPath)}`;
}
