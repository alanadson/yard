/**
 * Agent usage limits (Claude, Codex, Grok).
 *
 * The backend (`usage.rs`) does the polling and pushes `usage://update`; what
 * lives here is only the latest snapshot and `nudge()` — the "check now" the
 * UI fires when usage has probably just changed (an agent finished a turn,
 * the window regained focus, the refresh button). The nudge has a local floor
 * so that a burst of triggers does not turn into a burst of fetches.
 */
import { create } from "zustand";

import { ipc, type ProviderUsage, type UsageSnapshot } from "../lib/ipc";

/** Between nudges; the backend still applies its own per-provider floor. */
const NUDGE_FLOOR_MS = 5_000;

let lastNudgeAt = 0;

interface UsageState {
  providers: ProviderUsage[];
  /** Epoch ms of the last snapshot received (0 = none yet). */
  fetchedAt: number;
  apply: (snap: UsageSnapshot) => void;
  /** Asks the backend for an immediate collection cycle (with a local floor). */
  nudge: () => void;
}

export const useUsage = create<UsageState>((set) => ({
  providers: [],
  fetchedAt: 0,

  apply: (snap) => set({ providers: snap.providers, fetchedAt: snap.fetchedAt }),

  nudge: () => {
    const now = Date.now();
    if (now - lastNudgeAt < NUDGE_FLOOR_MS) return;
    lastNudgeAt = now;
    ipc.usageRefresh().catch(() => {
      // With no backend (test, broken HMR) the normal polling still holds.
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
