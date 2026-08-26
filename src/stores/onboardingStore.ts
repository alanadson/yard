/**
 * Whether the welcome sheet has been seen — and the one-shot decision that
 * opens it.
 *
 * Two inputs arrive at different moments: the kv snapshot (`load`, at boot)
 * and the workspace (`projects`, once `projectsStore.load` resolves). The
 * hook calls `decide` whenever either lands; the store makes sure the answer
 * is `"show"` at most once per session, because `projectsStore.load` also
 * runs mid-session to recover from a snapshot the backend refused.
 */
import { create } from "zustand";

import { KV_ONBOARDING, firstRunDecision, type FirstRun } from "../lib/onboarding";
import { persistPref, type PrefsSnapshot } from "../lib/prefs";

interface OnboardingState {
  /** The key exists in kv (or was written this session). */
  done: boolean;
  /** The boot snapshot has been read — before that, nothing is decided. */
  loaded: boolean;
  /** The sheet was opened this session; a reload of the workspace must not reopen it. */
  shown: boolean;
  load: (prefs: PrefsSnapshot) => void;
  /**
   * The answer for the workspace as it stands. `"show"` flips `shown`;
   * `"adopt"` writes the key on the spot, silently.
   */
  decide: (projects: number) => FirstRun;
  /** Closing the sheet, whatever the gesture. One write per install. */
  markDone: (onError?: (error: unknown) => void) => void;
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  done: false,
  loaded: false,
  shown: false,

  load: (prefs) => set({ done: prefs[KV_ONBOARDING] !== undefined, loaded: true }),

  decide: (projects) => {
    const { loaded, done, shown } = get();
    if (!loaded || shown) return "done";
    const decision = firstRunDecision({ done: done ? "1" : undefined, projects });
    if (decision === "show") set({ shown: true });
    if (decision === "adopt") get().markDone();
    return decision;
  },

  markDone: (onError) => {
    if (get().done) return;
    set({ done: true, shown: true });
    persistPref(KV_ONBOARDING, "1", (error) => {
      if (onError) onError(error);
      else console.warn("[yard] não consegui gravar onboarding.done", error);
    });
  },
}));
