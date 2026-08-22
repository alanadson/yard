/**
 * Routine firing (§P1.2): scheduled prompts per terminal.
 *
 * A single timer for the whole app scans every group — a routine on a group
 * that is off-screen still counts, otherwise "every 30 min" would become
 * "every 30 min while you are looking".
 *
 * The rule that matters: **only fire on a live, idle terminal**. Pushing a
 * prompt into an agent that is mid-work would corrupt its input (and, on an
 * agent asking "1/2/3", answer the wrong question). So delay always goes
 * forward: a routine that comes due while the agent is typing waits for
 * the next tick.
 */
import { useEffect } from "react";

import { injectPrompt } from "../lib/inject";
import { canSend } from "../lib/sendable";
import { commitCanvasExternal } from "../lib/canvasWrite";
import { routineDue, type RoutineDef } from "../lib/canvas";
import { uiLog } from "../lib/log";
import { baseName } from "../lib/terminals";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

/** Scheduler tick. Routines are minute-scale; 30 s resolution is enough. */
const TICK_MS = 30_000;

export function useRoutines() {
  useEffect(() => {
    let running = false;

    const tick = async () => {
      // Firing is async (PTY inject with a pause before Enter); two
      // overlapping ticks would send the same prompt twice.
      if (running) return;
      running = true;
      try {
        const now = Date.now();
        const s = useProjects.getState();
        const targetName = (id: string) => {
          const row = s.terminal(id);
          return row ? baseName(row) : "(removido)";
        };

        for (const group of s.groups) {
          const canvas = s.layoutOf(group.id).canvas;
          const routines = canvas?.routines;
          if (!routines?.length) continue;

          const fired: RoutineDef[] = [];
          for (const r of routines) {
            if (!routineDue(r, now)) continue;
            const term = s.terminal(r.terminalId);
            if (!term || term.groupId !== group.id) continue;
            // Alive, not mid-write and not frozen on a question — the same
            // rule the composer, the bench and the diff review now use, which
            // is why it lives in `lib/sendable` instead of being spelled out
            // here. Delay always goes forward: a routine that comes due while
            // the agent is busy waits for the next tick.
            if (!canSend(r.terminalId, now)) continue;
            fired.push(r);
          }
          if (!fired.length) continue;

          // Only what actually went out is marked. Marking on intent burned a
          // `--once` routine that never left the app: `lastRunAt` said "último:
          // 14:32" for a prompt the agent never saw, `enabled` went to false,
          // and the single line in `yard.log` was the only trace anywhere.
          const delivered: RoutineDef[] = [];
          const failures: { r: RoutineDef; error: unknown }[] = [];
          for (const r of fired) {
            try {
              await injectPrompt(r.terminalId, r.text);
              delivered.push(r);
              uiLog.info(`rotina ${r.id} disparada em ${r.terminalId}`);
            } catch (e) {
              failures.push({ r, error: e });
              uiLog.error(`rotina ${r.id} falhou: ${e}`);
            }
          }

          for (const { r, error: err } of failures) {
            // Stays scheduled: the next tick tries again. The user hears about
            // it because a scheduled prompt silently not happening is exactly
            // the failure nobody notices.
            useUI
              .getState()
              .showToast(
                `A rotina [${r.id}] não chegou em "${targetName(r.terminalId)}": ${err}. ` +
                  "Continua agendada.",
                "error",
              );
          }

          if (!delivered.length) continue;
          const ids = new Set(delivered.map((r) => r.id));
          commitCanvasExternal(group.id, (c) => ({
            ...c,
            routines: (c.routines ?? []).map((r) =>
              ids.has(r.id)
                ? { ...r, lastRunAt: now, enabled: r.once ? false : r.enabled }
                : r,
            ),
          }));
        }
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    return () => clearInterval(timer);
  }, []);
}
