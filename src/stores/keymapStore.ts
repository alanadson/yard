/**
 * The board's key bindings, hydrated from the kv and written back on change.
 *
 * `map` is what the key handler and the toolbar read; `overrides` is what is
 * persisted (`keys.canvas`), so a default that changes in a later build
 * reaches whoever never touched that action.
 */
import { create } from "zustand";

import {
  normalizeKeymap,
  resolveKeymap,
  type CanvasAction,
  type Chord,
  type Keymap,
  type KeymapOverrides,
} from "../lib/keymap";
import { uiLog } from "../lib/log";
import { persistJsonPref, type PrefsSnapshot } from "../lib/prefs";

const PREF_KEY = "keys.canvas";

interface KeymapState {
  overrides: KeymapOverrides;
  map: Keymap;
  /** Reads the kv snapshot the boot already fetched. */
  load: (prefs: PrefsSnapshot) => void;
  /** Binds a chord to an action, or switches the action off with `null`. */
  bind: (action: CanvasAction, chord: Chord | null) => void;
  /** Back to the default for one action. */
  reset: (action: CanvasAction) => void;
  resetAll: () => void;
}

function persist(overrides: KeymapOverrides): void {
  persistJsonPref(PREF_KEY, overrides, (e) =>
    uiLog.warn(`não consegui gravar os atalhos do canvas: ${e}`),
  );
}

export const useKeymap = create<KeymapState>((set, get) => ({
  overrides: {},
  map: resolveKeymap({}),

  load: (prefs) => {
    let overrides: KeymapOverrides = {};
    const raw = prefs[PREF_KEY];
    if (typeof raw === "string" && raw.trim()) {
      try {
        overrides = normalizeKeymap(JSON.parse(raw));
      } catch {
        overrides = {};
      }
    }
    set({ overrides, map: resolveKeymap(overrides) });
  },

  bind: (action, chord) => {
    const overrides = { ...get().overrides, [action]: chord };
    set({ overrides, map: resolveKeymap(overrides) });
    persist(overrides);
  },

  reset: (action) => {
    const overrides = { ...get().overrides };
    delete overrides[action];
    set({ overrides, map: resolveKeymap(overrides) });
    persist(overrides);
  },

  resetAll: () => {
    set({ overrides: {}, map: resolveKeymap({}) });
    persist({});
  },
}));
