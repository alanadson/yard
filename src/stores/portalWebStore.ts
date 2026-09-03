/**
 * What every portal shares: the addresses visited and the ones starred.
 *
 * Both live in the kv, hydrated at boot and written back on change, and
 * both are read by every card and browser tab, which is the point: a
 * bookmark starred in a pane is one keystroke away on the board.
 */
import { create } from "zustand";

import { uiLog } from "../lib/log";
import { normalizeBookmarks, toggleBookmark, type Bookmark } from "../lib/portalBookmarks";
import { persistJsonPref, type PrefsSnapshot } from "../lib/prefs";
import { normalizeVisits, recordVisit, type Visit } from "../lib/urlHistory";

const HISTORY_KEY = "portal.history";
const BOOKMARKS_KEY = "portal.bookmarks";

interface PortalWebState {
  history: Visit[];
  bookmarks: Bookmark[];
  load: (prefs: PrefsSnapshot) => void;
  /** A page was reached, by the user or by the agent. */
  visited: (url: string, now?: number) => void;
  toggleBookmark: (mark: Bookmark) => void;
  clearHistory: () => void;
}

function parse(raw: string | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const usePortalWeb = create<PortalWebState>((set, get) => ({
  history: [],
  bookmarks: [],

  load: (prefs) => {
    set({
      history: normalizeVisits(parse(prefs[HISTORY_KEY])),
      bookmarks: normalizeBookmarks(parse(prefs[BOOKMARKS_KEY])),
    });
  },

  visited: (url, now = Date.now()) => {
    const history = recordVisit(get().history, url, now);
    set({ history });
    persistJsonPref(HISTORY_KEY, history, (e) =>
      uiLog.warn(`não consegui gravar o histórico dos portais: ${e}`),
    );
  },

  toggleBookmark: (mark) => {
    const bookmarks = toggleBookmark(get().bookmarks, mark);
    set({ bookmarks });
    persistJsonPref(BOOKMARKS_KEY, bookmarks, (e) =>
      uiLog.warn(`não consegui gravar os favoritos dos portais: ${e}`),
    );
  },

  clearHistory: () => {
    set({ history: [] });
    persistJsonPref(HISTORY_KEY, [], () => {});
  },
}));
