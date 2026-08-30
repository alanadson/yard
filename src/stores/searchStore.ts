/**
 * Project-wide content search — the state behind the magnifier in the bench's
 * Files tab (Ctrl+Shift+F; internally still the `search` tab).
 *
 * A store rather than component state for one reason: the panel unmounts when
 * the user switches tabs, and a result list that evaporates on the way to the
 * file it found is a search nobody trusts. Nothing here persists to disk —
 * a search is about *now*.
 */
import { create } from "zustand";

import { ipc, type ReplaceOutcome, type SearchOptions, type SearchOutcome } from "../lib/ipc";
import { sameRoot } from "../lib/roots";
import { useEditor } from "./editorStore";

export type SearchStatus = "idle" | "searching" | "done" | "error";

interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Read the query as a pattern rather than as text. */
  regex: boolean;
  /** Comma separated globs; empty means every file. */
  include: string;
  /** Comma separated globs; empty means nothing is excluded. */
  exclude: string;
  /** What the matches become. Its own field, so it survives a tab switch. */
  replacement: string;
  /** The panel shows the replace row at all. */
  replacing: boolean;
  status: SearchStatus;
  error: string | null;
  outcome: SearchOutcome | null;
  /** Root the outcome came from — a floor switch makes it stale. */
  root: string | null;
  /** Files whose hits the user folded away. */
  collapsed: Record<string, boolean>;

  setQuery: (query: string) => void;
  setCaseSensitive: (on: boolean) => void;
  setWholeWord: (on: boolean) => void;
  setRegex: (on: boolean) => void;
  setInclude: (value: string) => void;
  setExclude: (value: string) => void;
  setReplacement: (value: string) => void;
  setReplacing: (on: boolean) => void;
  /**
   * Rewrites every match of the current search. The caller is responsible for
   * having asked the user first — see `lib/replaceScope.ts` for whether it is
   * even allowed to run.
   */
  replace: () => Promise<ReplaceOutcome | null>;
  toggleFile: (path: string) => void;
  /** Runs the search against the editor's root. No-op on an empty query. */
  run: () => Promise<void>;
  clear: () => void;
}

/** Below this, everything matches and the walk is pure heat. */
export const MIN_QUERY = 2;

let seq = 0;
let activeRoot: string | null = null;

/** Invalidates the UI answer and asks Rust to stop the disk walk immediately. */
function cancelActive() {
  seq++;
  const root = activeRoot;
  activeRoot = null;
  if (root) void ipc.fsCancelSearch(root).catch(() => {});
}

export const useSearch = create<SearchState>((set, get) => ({
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
  replacement: "",
  replacing: false,
  status: "idle",
  error: null,
  outcome: null,
  root: null,
  collapsed: {},

  setQuery: (query) => {
    if (query !== get().query) cancelActive();
    set({
      query,
      ...(query.trim().length < MIN_QUERY
        ? { status: "idle" as const, error: null, outcome: null }
        : {}),
    });
  },
  setCaseSensitive: (caseSensitive) => {
    if (caseSensitive !== get().caseSensitive) cancelActive();
    set({ caseSensitive });
  },
  setWholeWord: (wholeWord) => {
    if (wholeWord !== get().wholeWord) cancelActive();
    set({ wholeWord });
  },
  setRegex: (regex) => {
    if (regex !== get().regex) cancelActive();
    set({ regex });
  },
  setInclude: (include) => {
    if (include !== get().include) cancelActive();
    set({ include });
  },
  setExclude: (exclude) => {
    if (exclude !== get().exclude) cancelActive();
    set({ exclude });
  },
  // Neither of these two changes what was found, so neither cancels the walk.
  setReplacement: (replacement) => set({ replacement }),
  setReplacing: (replacing) => set({ replacing }),
  toggleFile: (path) =>
    set((s) => ({ collapsed: { ...s.collapsed, [path]: !s.collapsed[path] } })),

  run: async () => {
    const { query } = get();
    const root = useEditor.getState().root;
    const text = query.trim();
    if (!root || text.length < MIN_QUERY) return;

    const mine = ++seq;
    activeRoot = root;
    set({ status: "searching", error: null });
    try {
      const outcome = await ipc.fsSearchText(root, text, optionsOf(get()));
      // A slower search must not answer a newer question.
      if (mine !== seq) return;
      set({ outcome, root, status: "done", collapsed: {} });
    } catch (e) {
      if (mine !== seq) return;
      set({ status: "error", error: String(e), outcome: null });
    } finally {
      if (mine === seq) activeRoot = null;
    }
  },

  replace: async () => {
    const { query, replacement } = get();
    const root = useEditor.getState().root;
    const text = query.trim();
    if (!root || text.length < MIN_QUERY) return null;
    const outcome = await ipc.fsReplaceText(root, text, replacement, optionsOf(get()));
    // The disk moved under the list that produced this. Re-running is not
    // politeness: with the matches gone, the old list is a set of dead links.
    await get().run();
    return outcome;
  },

  clear: () => {
    cancelActive();
    set({ query: "", status: "idle", error: null, outcome: null, collapsed: {} });
  },
}));

/** The five fields the backend takes, out of the state that holds nine. */
function optionsOf(state: SearchState): SearchOptions {
  return {
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    regex: state.regex,
    include: state.include,
    exclude: state.exclude,
  };
}

/** Is the stored result about the root on screen? (a floor switch outdates it) */
export function outcomeIsCurrent(state: {
  root: string | null;
  outcome: SearchOutcome | null;
}): boolean {
  if (!state.outcome) return false;
  return sameRoot(state.root, useEditor.getState().root);
}
