/**
 * Whether automation is paused, and the writes that tell the native side
 * (`lib/automationPause.ts` holds every rule).
 *
 * The kv key `automation.paused` is the channel: the native scheduler reads
 * it before delivering a queue item or a routine and before a native flow
 * starts a stage, and the front end's own automatic senders read this store.
 * The state here is set *before* the write resolves, so a sender that runs
 * in the same tick already sees the pause.
 */
import { create } from "zustand";

import {
  KV_AUTOMATION_PAUSED,
  KV_PAUSE_SUPPRESSED,
  parsePause,
  parseSuppression,
  pauseMessage,
  pauseToApply,
  serializePause,
  suppressAfterResume,
  type AutomationPause,
  type PauseSuppression,
} from "../lib/automationPause";
import type { BudgetLevel } from "../lib/budget";
import { ipc } from "../lib/ipc";
import { uiLog } from "../lib/log";
import type { PrefsSnapshot } from "../lib/prefs";
import { useUI } from "./uiStore";

export interface AutomationReading {
  budgetLevel?: BudgetLevel;
  quotaPct?: number | null;
}

interface AutomationState {
  paused: AutomationPause | null;
  suppressed: PauseSuppression | null;
  /** Boot: a pause left by the previous run is still in force. */
  load: (prefs: PrefsSnapshot) => void;
  /** One reading of the budget or the quota; pauses when the rule says so. */
  observe: (reading: AutomationReading, now: number) => Promise<AutomationPause | null>;
  /** The user's resume, from the status bar chip. */
  resume: (now: number) => Promise<void>;
}

async function write(key: string, value: string): Promise<void> {
  try {
    await ipc.writePref(key, value);
  } catch (e) {
    uiLog.error(`automação: não consegui gravar ${key}: ${e}`);
  }
}

export const useAutomation = create<AutomationState>((set, get) => ({
  paused: null,
  suppressed: null,

  load: (prefs) =>
    set({
      paused: parsePause(prefs[KV_AUTOMATION_PAUSED]),
      suppressed: parseSuppression(prefs[KV_PAUSE_SUPPRESSED]),
    }),

  observe: async (reading, now) => {
    const { prefs } = useUI.getState();
    const pause = pauseToApply({
      ...reading,
      prefs: { budgetPauseAutomation: prefs.budgetPauseAutomation, quotaPausePct: prefs.quotaPausePct },
      current: get().paused,
      suppressed: get().suppressed,
      now,
    });
    if (!pause) return null;
    set({ paused: pause });
    uiLog.info(`automação pausada: ${pause.reason}`);
    useUI.getState().showToast(pauseMessage(pause), "error");
    await write(KV_AUTOMATION_PAUSED, serializePause(pause));
    return pause;
  },

  resume: async (now) => {
    const pause = get().paused;
    if (!pause) return;
    const suppressed = suppressAfterResume(get().suppressed, pause, now);
    set({ paused: null, suppressed });
    uiLog.info(`automação retomada (${pause.reason})`);
    await write(KV_AUTOMATION_PAUSED, serializePause(null));
    await write(KV_PAUSE_SUPPRESSED, JSON.stringify(suppressed));
  },
}));
