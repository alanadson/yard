/**
 * The ceiling on the day's spend, watched (`lib/budget.ts` holds the rules).
 *
 * One timer for the whole app. It reads the same `usage_history` the "Custos e
 * uso" panel reads — the CLIs' own session files, folded by the backend — and
 * compares today's total against the preference. When the level gets *worse*
 * it says so once: a toast, a native balloon, and the `budget` trigger edge,
 * so an automation can react (pause an agent, tell another one to stop).
 *
 * The five-minute tick is deliberate. The numbers move as agents write their
 * session files, which is to say slowly and in bursts; a tighter loop would
 * re-read a few megabytes of JSONL to learn nothing. The first read happens on
 * boot, so a level already blown when the app opens is heard about at once.
 */
import { useEffect } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { budgetMessage, budgetState, worsened, type BudgetLevel } from "../lib/budget";
import { localDay, totals } from "../lib/costs";
import { fireBudgetEdge } from "./useTriggers";
import { t } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { uiLog } from "../lib/log";
import { pushOut } from "../lib/notifyOut";
import { useUI } from "../stores/uiStore";

/** The session files move in bursts; there is nothing to learn faster than this. */
const TICK_MS = 5 * 60_000;

export function useBudgetWatch() {
  const limit = useUI((s) => s.prefs.budgetDaily);

  useEffect(() => {
    if (!limit || limit <= 0) return;
    let alive = true;
    // Per day: crossing back to "ok" at midnight is not news, but the *next*
    // day's first crossing is, so the memory resets with the date.
    let day = "";
    let level: BudgetLevel = "off";
    let running = false;

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const rows = await ipc.usageHistory(1);
        if (!alive) return;
        const today = localDay(new Date());
        if (day !== today) {
          day = today;
          level = "off";
        }
        const mine = rows.filter((row) => row.day === today);
        const sum = totals(mine);
        const state = budgetState(sum.costUsd ?? 0, limit, sum.priced);
        if (worsened(level, state.level)) {
          const message = budgetMessage(state);
          useUI.getState().showToast(message, state.level === "over" ? "error" : undefined);
          uiLog.info(`orçamento: ${state.level} (${state.pct}%)`);
          void notify(message);
          if (state.level !== "off" && state.level !== "ok") fireBudgetEdge(state.level);
        }
        level = state.level;
      } catch (e) {
        // A costs read that fails is not worth a word: the panel says so when
        // the user opens it, and a balloon about a failed *budget check* is a
        // notification about nothing having happened.
        uiLog.warn(`orçamento: não consegui ler os custos: ${e}`);
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [limit]);
}

async function notify(body: string): Promise<void> {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title: t("Yard — orçamento"), body });
    pushOut(t("Yard — orçamento"), body, "budget");
  } catch (e) {
    uiLog.warn(`orçamento: notificação indisponível: ${e}`);
  }
}
