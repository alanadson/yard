/**
 * Agent usage limits (Claude, Codex, Grok).
 *
 * The backend (`usage.rs`) does the polling and pushes `usage://update`; what
 * lives here is only the latest snapshot and `nudge()` — the "check now" the
 * UI fires when usage has probably just changed (an agent finished a turn,
 * the window regained focus, the refresh button). The nudge has a floor per
 * provider (`lib/usageNudge.ts`) so that a burst of triggers does not turn
 * into a burst of fetches.
 */
import { create } from "zustand";

import { ipc, type ProviderUsage, type UsageSnapshot } from "../lib/ipc";
import { createNudgeGate, type UsageProvider } from "../lib/usageNudge";
import { isWindowShown } from "../lib/windowShown";

/** One minute between nudges of the same provider (`lib/usageNudge.ts`). */
const gate = createNudgeGate();

/**
 * The refresh button is the user asking, so it skips the minute: only a
 * double click is absorbed. The backend still holds its own 429 backoff.
 */
const MANUAL_FLOOR_MS = 5_000;
let lastManual = -Infinity;

interface UsageState {
  providers: ProviderUsage[];
  /** Epoch ms of the last snapshot received (0 = none yet). */
  fetchedAt: number;
  apply: (snap: UsageSnapshot) => void;
  /**
   * Asks the backend for an immediate read of one provider (or of all when
   * omitted), at most once a minute each and never for a hidden window.
   */
  nudge: (provider?: UsageProvider, now?: number, shown?: boolean) => void;
  /** The chip's refresh button: every provider, now, a double click absorbed. */
  refreshNow: (now?: number) => void;
}

export const useUsage = create<UsageState>((set) => ({
  providers: [],
  fetchedAt: 0,

  apply: (snap) => set({ providers: snap.providers, fetchedAt: snap.fetchedAt }),

  nudge: (provider, now = Date.now(), shown = isWindowShown()) => {
    if (!gate.take(provider, now, shown)) return;
    ipc.usageRefresh(provider).catch(() => {
      // With no backend (test, broken HMR) the normal polling still holds.
    });
  },

  refreshNow: (now = Date.now()) => {
    if (now - lastManual < MANUAL_FLOOR_MS) return;
    lastManual = now;
    ipc.usageRefresh().catch(() => {
      // Same as above: the backend's own polling still holds.
    });
  },
}));

/** The provider's most consumed window — the number the chip shows. */
export function worstWindow(p: ProviderUsage) {
  return p.windows.reduce<ProviderUsage["windows"][number] | null>(
    (worst, w) => (worst === null || w.usedPercent > worst.usedPercent ? w : worst),
    null,
  );
}
