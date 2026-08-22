/**
 * What each terminal announced it is serving.
 *
 * Session-only, like the PTY runtime mirror: an address is true while the
 * process is up and meaningless after it. Nothing here is persisted.
 *
 * The scanner state (the tail of a line waiting for its newline) lives in a
 * module `Map` rather than in the store — it changes on every chunk and
 * nobody paints it, the same rule `terminalsStore` follows for the activity
 * heartbeat.
 */
import { create } from "zustand";

import {
  createUrlScanner,
  groupAdvertised,
  mergeAdvertised,
  type AdvertisedUrl,
  type UrlScanner,
} from "../lib/advertised";
import { useProjects } from "./projectsStore";

const scanners = new Map<string, UrlScanner>();
/** terminal -> group, so a sibling's address can be found without a lookup. */
const groups = new Map<string, string>();

/** Shared empty list: a stable reference keeps selectors quiet. */
const EMPTY: AdvertisedUrl[] = [];

function scannerFor(terminalId: string): UrlScanner {
  const found = scanners.get(terminalId);
  if (found) return found;
  const fresh = createUrlScanner();
  scanners.set(terminalId, fresh);
  return fresh;
}

interface AdvertisedState {
  byTerminal: Record<string, AdvertisedUrl[]>;
  /**
   * Everything announced inside a group, whichever CLI printed it.
   *
   * A project usually has one dev server and several agents working on it:
   * the one that ran `npm run dev` printed the address, and the others — same
   * project, same site — had no way to offer it. The card reads this index,
   * so any of them opens the portal, wired to itself.
   */
  byGroup: Record<string, AdvertisedUrl[]>;
  /** Feeds a raw PTY chunk. Called on every output event — must stay cheap. */
  ingest: (terminalId: string, chunk: string) => void;
  /** The process went down: what it was serving went with it. */
  forget: (terminalId: string) => void;
}

/** Rebuilds a group's list from the terminals still announcing something. */
function regroup(
  byTerminal: Record<string, AdvertisedUrl[]>,
  current: AdvertisedUrl[],
  groupId: string,
): AdvertisedUrl[] {
  return groupAdvertised(byTerminal, (id) => groups.get(id), groupId, current);
}

function groupOf(terminalId: string): string | null {
  const known = groups.get(terminalId);
  if (known) return known;
  const found = useProjects.getState().terminal(terminalId)?.groupId ?? null;
  if (found) groups.set(terminalId, found);
  return found;
}

export const useAdvertised = create<AdvertisedState>((set, get) => ({
  byTerminal: {},
  byGroup: {},

  ingest: (terminalId, chunk) => {
    const found = scannerFor(terminalId).feed(chunk);
    if (found.length === 0) return;
    const current = get().byTerminal[terminalId] ?? EMPTY;
    const next = mergeAdvertised(current, found);
    // Same array back = nothing new. Writing anyway would wake every selector
    // watching the map, several times a second, for no change at all.
    if (next === current) return;
    const groupId = groupOf(terminalId);
    set((s) => {
      const byTerminal = { ...s.byTerminal, [terminalId]: next };
      if (!groupId) return { byTerminal };
      const grouped = regroup(byTerminal, s.byGroup[groupId] ?? EMPTY, groupId);
      if (grouped === (s.byGroup[groupId] ?? EMPTY)) return { byTerminal };
      return { byTerminal, byGroup: { ...s.byGroup, [groupId]: grouped } };
    });
  },

  forget: (terminalId) => {
    scanners.delete(terminalId);
    const groupId = groups.get(terminalId) ?? null;
    groups.delete(terminalId);
    if (!get().byTerminal[terminalId]) return;
    set((s) => {
      const byTerminal = { ...s.byTerminal };
      delete byTerminal[terminalId];
      if (!groupId) return { byTerminal };
      const grouped = regroup(byTerminal, s.byGroup[groupId] ?? EMPTY, groupId);
      const byGroup = { ...s.byGroup };
      if (grouped.length === 0) delete byGroup[groupId];
      else byGroup[groupId] = grouped;
      return { byTerminal, byGroup };
    });
  },
}));

export function advertisedOf(terminalId: string): AdvertisedUrl[] {
  return useAdvertised.getState().byTerminal[terminalId] ?? EMPTY;
}
