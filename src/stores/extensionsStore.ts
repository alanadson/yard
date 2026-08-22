/**
 * Which extensions are on. One kv key (`ext.enabled`) holding a JSON object
 * `{ id: true }` — absence means off, so a fresh profile starts with every
 * extension disabled and the app looking exactly like it did before the store
 * existed. The catalog itself lives in `lib/extensions.ts`; this store only
 * remembers the switches.
 */
import { create } from "zustand";

import { EXTENSIONS, type ExtensionId } from "../lib/extensions";
import {
  persistJsonPref,
  readPrefs,
  type PrefsSnapshot,
} from "../lib/prefs";

const KV_ENABLED = "ext.enabled";

/**
 * kv gives back text; never trust the saved format. Ids that left the catalog
 * are dropped on read, so an old profile cannot resurrect a removed extension.
 */
export function parseEnabled(
  raw: string | undefined,
): Partial<Record<ExtensionId, boolean>> {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const known = new Set<string>(EXTENSIONS.map((e) => e.id));
    const out: Partial<Record<ExtensionId, boolean>> = {};
    for (const [id, on] of Object.entries(data)) {
      if (known.has(id) && on === true) out[id as ExtensionId] = true;
    }
    // A hand-edited kv can bring two of the same category; catalog order
    // breaks the tie so the app never boots with both claiming the tree.
    const seen = new Set<string>();
    for (const ext of EXTENSIONS) {
      if (!ext.category || out[ext.id] !== true) continue;
      if (seen.has(ext.category)) delete out[ext.id];
      else seen.add(ext.category);
    }
    return out;
  } catch {
    return {};
  }
}

interface ExtensionsState {
  enabled: Partial<Record<ExtensionId, boolean>>;
  load: (prefs?: PrefsSnapshot) => Promise<void>;
  setEnabled: (id: ExtensionId, on: boolean) => void;
}

export const useExtensions = create<ExtensionsState>((set, get) => ({
  enabled: {},

  load: async (prefs) => {
    try {
      const raw = prefs ?? (await readPrefs());
      set({ enabled: parseEnabled(raw[KV_ENABLED]) });
    } catch (e) {
      console.warn("[yard] não consegui ler as extensões", e);
    }
  },

  setEnabled: (id, on) => {
    const enabled = { ...get().enabled };
    if (on) {
      // Same category = same slot: two icon themes at once would both claim
      // the tree, so turning one on retires its siblings.
      const category = EXTENSIONS.find((e) => e.id === id)?.category;
      if (category) {
        for (const other of EXTENSIONS) {
          if (other.id !== id && other.category === category) delete enabled[other.id];
        }
      }
      enabled[id] = true;
    } else {
      delete enabled[id];
    }
    set({ enabled });
    persistJsonPref(KV_ENABLED, enabled, (error) =>
      console.warn(`[yard] não consegui gravar ${KV_ENABLED}`, error),
    );
  },
}));
