/**
 * The runtime half of the work queue (`lib/queue.ts` has the rules,
 * `stores/queueStore.ts` the state): one timer for the whole app that hands
 * the head item of each ready terminal to `injectPrompt`.
 *
 * A timer, not a subscription to the runtime mirror, and deliberately so.
 * "Ready" is partly a *time* condition — five seconds of silence
 * (`sendable.IDLE_MS`) — and the last byte of an agent's answer produces no
 * further event. A subscription would wake up on that byte, find the terminal
 * still busy, and then never wake again: the prompt would sit in the queue
 * until something unrelated happened. The tick asks the question until the
 * answer is yes.
 *
 * Reservations remain persisted until delivery is acknowledged. A failed
 * write leaves an uncertain item for explicit review instead of retrying
 * text that may already have reached the agent.
 */
import { useEffect } from "react";

import { t } from "../lib/i18n";
import { on } from "../lib/ipc";
import { startWindowLiveRead } from "./useLiveRead";
import { deliverQueueItem, refreshNativeQueue } from "../lib/queueDelivery";
import { nativeQueueScheduling } from "../lib/prefs";
import { uiLog } from "../lib/log";
import { dueItems } from "../lib/queue";
import { canSend } from "../lib/sendable";
import { baseName } from "../lib/terminals";
import { useProjects } from "../stores/projectsStore";
import { useQueue } from "../stores/queueStore";
import { useUI } from "../stores/uiStore";

/** Same resolution as the routine scheduler: the wait is seconds-scale. */
const TICK_MS = 2_000;

export function useQueueRunner() {
  useEffect(() => {
    // The backend schedules and delivers: the page only mirrors the queue.
    // One reader owns the announcements, boot, visibility catch-up and safety
    // tick. Event bursts share a read and a hidden window waits until shown.
    if (nativeQueueScheduling()) {
      return startWindowLiveRead({
        read: refreshNativeQueue,
        events: [on.queueChanged],
        onError: (error) => uiLog.warn(`queue: native read failed: ${error}`),
      });
    }
    let running = false;

    const tick = async () => {
      // `injectPrompt` writes and then presses Enter after a pause; two
      // overlapping ticks would interleave two prompts in one line.
      if (running) return;
      let state = useQueue.getState();
      if (state.items.length === 0) return;
      running = true;
      try {
        if (state.items.some((item) => item.delivery?.owner === "native")) {
          await refreshNativeQueue();
          state = useQueue.getState();
        }
        const now = Date.now();
        const due = dueItems(state.items, (id) => canSend(id, now));
        for (const head of due) {
          // Taken, not read: between the decision and the write there is an
          // await, and the queue must not offer the same item to anything else.
          try {
            const result = await deliverQueueItem(head, canSend, now);
            if (result.status === "skipped") continue;
            if (result.status === "uncertain" || result.status === "failed") throw new Error(result.error);
            uiLog.info(
              `queue: item delivered to ${head.terminalId} (source ${head.source})`,
            );
          } catch (e) {
            uiLog.error(`fila: entrega falhou em ${head.terminalId}: ${e}`);
            const row = useProjects.getState().terminal(head.terminalId);
            useUI
              .getState()
              .showToast(
                t('A fila não conseguiu escrever em "{target}": {reason}.', {
                  target: row ? baseName(row) : head.terminalId,
                  reason: String(e),
                }),
                "error",
              );
          }
        }
      } finally {
        running = false;
      }
    };

    const timer = window.setInterval(() => void tick(), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // A card closed or a project removed leaves prompts addressed to nobody.
  // The prune is a subscription rather than a call at each of the six places
  // a terminal can vanish — the one that forgets is the one that leaves a
  // ghost queue counting up on a card that no longer exists.
  useEffect(() => {
    const check = () => {
      const ids = new Set(useProjects.getState().terminals.map((term) => term.id));
      useQueue.getState().prune((id) => ids.has(id));
    };
    check();
    return useProjects.subscribe((state, prev) => {
      if (state.terminals !== prev.terminals) check();
    });
  }, []);
}
