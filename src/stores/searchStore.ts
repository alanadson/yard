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

import { ipc, type SearchOutcome } from "../lib/ipc";
import { sameRoot } from "../lib/roots";
import { useEditor } from "./editorStore";

export type SearchStatus = "idle" | "searching" | "done" | "error";

interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
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
  toggleFile: (path) =>
    set((s) => ({ collapsed: { ...s.collapsed, [path]: !s.collapsed[path] } })),

  run: async () => {
    const { query, caseSensitive, wholeWord } = get();
    const root = useEditor.getState().root;
    const text = query.trim();
    if (!root || text.length < MIN_QUERY) return;

    const mine = ++seq;
    activeRoot = root;
    set({ status: "searching", error: null });
    try {
      const outcome = await ipc.fsSearchText(root, text, caseSensitive, wholeWord);
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

  clear: () => {
    cancelActive();
    set({ query: "", status: "idle", error: null, outcome: null, collapsed: {} });
  },
}));

/** Is the stored result about the root on screen? (a floor switch outdates it) */
export function outcomeIsCurrent(state: {
  root: string | null;
  outcome: SearchOutcome | null;
}): boolean {
  if (!state.outcome) return false;
  return sameRoot(state.root, useEditor.getState().root);
}
