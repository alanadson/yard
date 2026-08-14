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

import { injectPrompt, commitCanvasExternal } from "../lib/bridge";
import { routineDue, type RoutineDef } from "../lib/canvas";
import { uiLog } from "../lib/log";
import { useProjects } from "../stores/projectsStore";
import { getActivity, useTerminals } from "../stores/terminalsStore";

/** Scheduler tick. Routines are minute-scale; 30 s resolution is enough. */
const TICK_MS = 30_000;
/** Minimum terminal silence for it to count as idle. */
const IDLE_MS = 5_000;

export function useRoutines() {
  useEffect(() => {
    let rodando = false;

    const tick = async () => {
      // Firing is async (PTY inject with a pause before Enter); two
      // overlapping ticks would send the same prompt twice.
      if (rodando) return;
      rodando = true;
      try {
        const agora = Date.now();
        const s = useProjects.getState();
        const rt = useTerminals.getState().byId;

        for (const group of s.groups) {
          const canvas = s.layoutOf(group.id).canvas;
          const routines = canvas?.routines;
          if (!routines?.length) continue;

          const disparadas: RoutineDef[] = [];
          for (const r of routines) {
            if (!routineDue(r, agora)) continue;
            const term = s.terminal(r.terminalId);
            if (!term || term.groupId !== group.id) continue;
            const run = rt[r.terminalId];
            if (run?.state !== "running") continue;
            // `lastByteAt` comes from the backend as epoch ms; with no bytes
            // yet, the terminal is sitting at the prompt and counts as idle.
            const { lastByteAt } = getActivity(r.terminalId);
            const ocioso = !lastByteAt || agora - lastByteAt > IDLE_MS;
            if (!ocioso) continue;
            disparadas.push(r);
          }
          if (!disparadas.length) continue;

          for (const r of disparadas) {
            try {
              await injectPrompt(r.terminalId, r.text);
              uiLog.info(`rotina ${r.id} disparada em ${r.terminalId}`);
            } catch (e) {
              uiLog.error(`rotina ${r.id} falhou: ${e}`);
            }
          }

          const ids = new Set(disparadas.map((r) => r.id));
          commitCanvasExternal(group.id, (c) => ({
            ...c,
            routines: (c.routines ?? []).map((r) =>
              ids.has(r.id)
                ? { ...r, lastRunAt: agora, enabled: r.once ? false : r.enabled }
                : r,
            ),
          }));
        }
      } finally {
        rodando = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    return () => clearInterval(timer);
  }, []);
}
