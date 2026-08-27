/**
 * Which extensions are on. One kv key (`ext.enabled`) holding a JSON object
 * `{ id: true }` — absence means off, so a fresh profile starts with every
 * extension disabled and the app looking exactly like it did before the store
 * existed. The catalog itself lives in `lib/extensions.ts`; this store only
 * remembers the switches.
 *
 * The colour schemes are the exception, and they sit in `ext.scheme`: a scheme
 * is not one switch but two slots, terminal and code, because the sixteen ANSI
 * tones a CLI draws in and the roles a grammar hands the editor are two
 * different jobs (`lib/schemeChoice.ts` holds the rules). Every profile that
 * exists still holds the old boolean, so `load` migrates it across on the way
 * in and drops it from `enabled` — one colour, one source of truth.
 */
import { create } from "zustand";

import { SCHEME_IDS } from "../lib/colorSchemes";
import { EXTENSIONS, type ExtensionId } from "../lib/extensions";
import {
  persistJsonPref,
  readPrefs,
  type PrefsSnapshot,
} from "../lib/prefs";
import { NO_SCHEME, parseSchemeChoice, type SchemeChoice } from "../lib/schemeChoice";

const KV_ENABLED = "ext.enabled";
const KV_SCHEME = "ext.scheme";

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
  /** One scheme per surface; `undefined` on a slot is the Yard's own palette. */
  scheme: SchemeChoice;
  load: (prefs?: PrefsSnapshot) => Promise<void>;
  setEnabled: (id: ExtensionId, on: boolean) => void;
  setScheme: (next: SchemeChoice) => void;
}

export const useExtensions = create<ExtensionsState>((set, get) => ({
  enabled: {},
  scheme: NO_SCHEME,

  load: async (prefs) => {
    try {
      const raw = prefs ?? (await readPrefs());
      // The old key is read first and *then* stripped: it is where a profile
      // written before the split still keeps its theme, and leaving a scheme
      // among the switches afterwards would give one colour two owners.
      const saved = parseEnabled(raw[KV_ENABLED]);
      const scheme = parseSchemeChoice(raw[KV_SCHEME], saved);
      const enabled = { ...saved };
      for (const id of SCHEME_IDS) delete enabled[id as ExtensionId];
      set({ enabled, scheme });
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

  /**
   * Always writes, even for the choice that looks empty. An absent key means
   * "the answer is still in the old place" — so a user who splits the surfaces
   * and puts the terminal back on the Yard's own palette has to leave a mark,
   * or the next launch migrates the old boolean straight over their choice.
   */
  setScheme: (next) => {
    set({ scheme: next });
    persistJsonPref(KV_SCHEME, next, (error) =>
      console.warn(`[yard] não consegui gravar ${KV_SCHEME}`, error),
    );
  },
}));
