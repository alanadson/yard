/**
 * The last tabs to be closed (`lib/reopen.ts` holds the rules).
 *
 * In memory and nowhere else: this is the undo for the last few minutes, not
 * a history. A file closed before the reload is found through the Busca.
 */
import { create } from "zustand";

import { popClosed, pushClosed, type ClosedTab } from "../lib/reopen";

interface ReopenState {
  stack: ClosedTab[];
  remember: (tab: ClosedTab) => void;
  /** Removes and returns the last closed tab, or `null`. */
  take: () => ClosedTab | null;
}

export const useReopen = create<ReopenState>((set, get) => ({
  stack: [],
  remember: (tab) => set((s) => ({ stack: pushClosed(s.stack, tab) })),
  take: () => {
    const { tab, rest } = popClosed(get().stack);
    if (tab) set({ stack: rest });
    return tab;
  },
}));
