/**
 * The state of the **Source Control** tab — version control for the open
 * project.
 *
 * The list of changed files **does not live here**: it already exists in
 * `changesStore`, fed by the file watcher with a debounced `git status`.
 * Duplicating that would run `git status` twice per keystroke of an agent.
 * This store handles the rest — the header (branch, upstream, what is in
 * progress), branches, stashes, tags, history — and, above all, the
 * **writes**: stage, discard, commit, switch branch, push.
 *
 * Two rules surround every write, and both exist because of a real bug:
 *
 * 1. **Finished, reload.** Without it the list keeps showing the world as it
 *    was before the click, and the next click acts on a row that no longer
 *    exists.
 * 2. **Failed, unlock.** A panel stuck on "busy" is the state in which no
 *    button responds and nothing on screen explains why.
 *
 * The commit message draft is per repository (and survives a restart, in a
 * `kv`): switching projects mid-sentence and coming back brings the sentence
 * back, and project A's text never becomes project B's commit.
 */
import { create } from "zustand";

import {
  ipc,
  type ScmBranch,
  type ScmCommit,
  type ScmCommitOpts,
  type ScmInfo,
  type ScmStash,
  type ScmTag,
} from "../lib/ipc";
import { persistJsonPref, type PrefsSnapshot } from "../lib/prefs";
import { rootKey } from "../lib/roots";

/** The tab's sections. The order is that of the segmented bar. */
export type ScmSection = "changes" | "history" | "branches" | "stash";

export interface ScmRepo {
  info: ScmInfo | null;
  branches: ScmBranch[];
  stashes: ScmStash[];
  tags: ScmTag[];
  commits: ScmCommit[];
  /** No more history pages to ask for. */
  logDone: boolean;
  loading: boolean;
  /** The name of the operation in progress, or `null`. */
  busy: string | null;
  /** What git answered the last time it refused. */
  error: string | null;
  /**
   * Bumped on every successful write. It is the "the repository moved" signal
   * for whoever cannot tell that from the `git status` summary — the diff
   * open on a row, above all: staging the **second** hunk of a file that was
   * already `MM` changes neither path, verb, side nor count, and still
   * changes the diff. Without this, the next click builds a patch from a text
   * that no longer exists.
   */
  version: number;
}

const EMPTY: ScmRepo = {
  info: null,
  branches: [],
  stashes: [],
  tags: [],
  commits: [],
  logDone: false,
  loading: false,
  busy: null,
  error: null,
  version: 0,
};

/** History page size — the same number the backend would use. */
export const LOG_PAGE = 60;

const KV_DRAFTS = "scm.drafts";
const KV_SECTION = "scm.section";

interface ScmState {
  /** The repository root on screen (the project's, or the active floor's). */
  root: string | null;
  /** Whose root that is — what lets the `changesStore` be reloaded along. */
  projectId: string | null;
  section: ScmSection;
  /** Amend instead of creating a new commit. */
  amend: boolean;
  byRoot: Record<string, ScmRepo>;
  /** Message draft, per root. */
  drafts: Record<string, string>;

  hydrate: (prefs: PrefsSnapshot) => void;
  setRepo: (projectId: string | null, root: string | null) => void;
  setSection: (section: ScmSection) => void;
  setAmend: (amend: boolean) => void;
  draftOf: (root: string | null | undefined) => string;
  setDraft: (root: string, text: string) => void;

  repoOf: (root: string | null | undefined) => ScmRepo;
  /**
   * The header, plus the lists **of the open section** — in one round. Always
   * asking for all four meant paying for three `git` processes per section
   * nobody is looking at, on every write and every tick of the watcher.
   */
  refresh: (root: string) => Promise<void>;
  loadLog: (root: string, more: boolean) => Promise<void>;
  /** The history of a single file — the same list, filtered and closed. */
  loadFileLog: (root: string, path: string) => Promise<void>;
  /**
   * Runs a write: marks busy, reloads at the end, returns the error message
   * (or `null`). Never throws — the caller is an `onClick`.
   */
  run: (root: string, label: string, fn: () => Promise<unknown>) => Promise<string | null>;
  commit: (root: string, opts: ScmCommitOpts) => Promise<string | null>;
}

function patch(
  set: (fn: (s: ScmState) => Partial<ScmState>) => void,
  root: string,
  change: Partial<ScmRepo> | ((prev: ScmRepo) => Partial<ScmRepo>),
) {
  const key = rootKey(root);
  set((s) => {
    const prev = s.byRoot[key] ?? EMPTY;
    const next = typeof change === "function" ? change(prev) : change;
    return { byRoot: { ...s.byRoot, [key]: { ...prev, ...next } } };
  });
}

export const useScm = create<ScmState>((set, get) => ({
  root: null,
  projectId: null,
  section: "changes",
  amend: false,
  byRoot: {},
  drafts: {},

  hydrate: (prefs) => {
    const drafts = parseDrafts(prefs[KV_DRAFTS]);
    const section = SECTIONS.includes(prefs[KV_SECTION] as ScmSection)
      ? (prefs[KV_SECTION] as ScmSection)
      : "changes";
    set({ drafts, section });
  },

  setRepo: (projectId, root) => {
    const current = get();
    if (current.projectId === projectId && sameKey(current.root, root)) return;
    // Amending is a decision about *this* commit; it does not cross projects.
    set({ projectId, root, amend: false });
  },

  setSection: (section) => {
    set({ section });
    persistJsonPref(KV_SECTION, section, (e) =>
      console.warn("[yard] não consegui gravar a seção do controle", e),
    );
    // The new section brings along what it draws: `refresh` only asks for the
    // open section's lists, so without this push Branches and Stash would
    // open empty until the next write.
    const { root } = get();
    if (root && (section === "branches" || section === "stash")) void get().refresh(root);
  },

  setAmend: (amend) => set({ amend }),

  draftOf: (root) => (root ? (get().drafts[rootKey(root)] ?? "") : ""),

  setDraft: (root, text) => {
    const key = rootKey(root);
    const drafts = { ...get().drafts, [key]: text };
    if (!text) delete drafts[key];
    set({ drafts });
    persistJsonPref(KV_DRAFTS, drafts, (e) =>
      console.warn("[yard] não consegui gravar o rascunho do commit", e),
    );
  },

  repoOf: (root) => (root ? (get().byRoot[rootKey(root)] ?? EMPTY) : EMPTY),

  refresh: async (root) => {
    patch(set, root, { loading: true });
    // Only what the section on screen draws.
    //
    // On Windows, spawning a `git` costs ~35 ms before it does anything at
    // all, and the three lists (branches, stashes, tags) feed sections that
    // are almost never open. Since every write ends here and the watcher
    // fires another `refresh` every time `git status` moves, that was ~110 ms
    // of process thrown away per click — and per keystroke of an agent that
    // is saving a file.
    const section = get().section;
    try {
      // In parallel: they are short, independent `git` processes, and waiting
      // for one after the other is what made the tab flicker on open.
      const [info, branches, stashes, tags] = await Promise.all([
        ipc.scmInfo(root),
        section === "branches"
          ? ipc.scmBranches(root).catch(() => [] as ScmBranch[])
          : null,
        section === "stash" ? ipc.scmStashList(root).catch(() => [] as ScmStash[]) : null,
        section === "branches" ? ipc.scmTags(root).catch(() => [] as ScmTag[]) : null,
      ]);
      patch(set, root, {
        info,
        loading: false,
        error: null,
        // `null` here is "did not ask", not "there is none": overwriting with
        // an empty list would wipe from the screen what the section just drew.
        ...(branches ? { branches } : {}),
        ...(stashes ? { stashes } : {}),
        ...(tags ? { tags } : {}),
      });
    } catch (e) {
      patch(set, root, { loading: false, error: String(e) });
    }
  },

  loadLog: async (root, more) => {
    const currentValue = get().repoOf(root);
    const skip = more ? currentValue.commits.length : 0;
    try {
      const page = await ipc.scmLog(root, { limit: LOG_PAGE, skip });
      patch(set, root, (prev) => ({
        commits: more ? [...prev.commits, ...page] : page,
        // A page smaller than requested = the end. It is the only signal git gives.
        logDone: page.length < LOG_PAGE,
        error: null,
      }));
    } catch (e) {
      patch(set, root, { error: String(e) });
    }
  },

  loadFileLog: async (root, path) => {
    try {
      const commits = await ipc.scmLog(root, { limit: LOG_PAGE, path });
      // Closed on purpose: asking for "more" with the filter lost would bring
      // the whole repository's history on top of the file's.
      patch(set, root, { commits, logDone: true, error: null });
    } catch (e) {
      patch(set, root, { error: String(e) });
    }
  },

  run: async (root, label, fn) => {
    patch(set, root, { busy: label, error: null });
    try {
      await fn();
    } catch (e) {
      const message = String(e);
      patch(set, root, { busy: null, error: message });
      return message;
    }
    patch(set, root, (prev) => ({ busy: null, version: prev.version + 1 }));
    // Both in parallel: they are independent reads, and one waiting for the
    // other added the whole `git status` (~170 ms in a big repository) to the
    // header (~150 ms) on every click.
    //
    // The `git status` that feeds the file list belongs to another store;
    // without this push the list would only update on the watcher's next event.
    const { projectId } = get();
    await Promise.all([
      get().refresh(root),
      projectId ? refreshChanges(projectId, root) : Promise.resolve(),
    ]);
    return null;
  },

  commit: async (root, opts) => {
    const message = get().draftOf(root);
    if (!message.trim()) return "Escreva a mensagem do commit";
    const err = await get().run(root, "commitando", () =>
      ipc.scmCommit(root, message, opts),
    );
    // The text only goes away once the commit exists: retyping the message
    // would be the wrong punishment for a hook that refused.
    if (!err) {
      get().setDraft(root, "");
      set({ amend: false });
    }
    return err;
  },
}));

const SECTIONS: ScmSection[] = ["changes", "history", "branches", "stash"];

function sameKey(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return rootKey(a) === rootKey(b);
}

function parseDrafts(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Loaded on demand so this store is not tied to the files one at the top of
 * the module: this file's tests swap the whole `ipc` for doubles, and a static
 * `import` would drag the chain of stores along.
 */
async function refreshChanges(projectId: string, root: string): Promise<void> {
  try {
    const { useChanges } = await import("./changesStore");
    await useChanges.getState().refreshGit(projectId, root);
  } catch {
    // Without the files panel mounted there is no list to update.
  }
}
