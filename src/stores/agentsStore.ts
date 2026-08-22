/**
 * This machine's agent catalog, in memory.
 *
 * The backend already answers, per CLI, what it can do — resume the last
 * conversation (`continueArgs`) and whether it writes a session to disk
 * (`sessionsKind`) — and two screens depended on that with no way to ask:
 *
 * - the "Retomar" strip only offered to start the CLI from scratch, in an app
 *   that sells suspend-and-come-back as session preservation;
 * - the "Ao Vivo" button showed up for every agent, and six of the nine CLIs
 *   in the catalog have no session at all to read — the screen sat waiting
 *   forever.
 *
 * Detection is expensive (it runs `--version` on every binary), so Rust keeps
 * it cached and one read per session is enough here: `refresh: false`.
 */
import { create } from "zustand";

import { ipc, type AgentInfo } from "../lib/ipc";
import { uiLog } from "../lib/log";

interface AgentsState {
  byId: Record<string, AgentInfo>;
  loaded: boolean;
  /** Reads the catalog once per session (or again, on request). */
  load: (refresh?: boolean) => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useAgents = create<AgentsState>((set) => ({
  byId: {},
  loaded: false,

  load: (refresh = false) => {
    if (inFlight && !refresh) return inFlight;
    const task = ipc
      .detectAgents(refresh)
      .then((list) => {
        const byId: Record<string, AgentInfo> = {};
        for (const a of list) byId[a.id] = a;
        set({ byId, loaded: true });
      })
      .catch((e) => {
        // Without the catalog the whole app keeps working: readers treat
        // "don't know" as "does not offer the extra".
        uiLog.warn(`não consegui ler o catálogo de agentes: ${e}`);
        set({ loaded: true });
      })
      .finally(() => {
        if (inFlight === task) inFlight = null;
      });
    inFlight = task;
    return task;
  },
}));

/**
 * Does this CLI write its session to disk? That is what decides whether
 * "Ao Vivo" has anything to show. Until the catalog arrives, nobody promises
 * anything.
 */
export function hasSessions(agentId: string | null | undefined): boolean {
  if (!agentId) return false;
  return !!useAgents.getState().byId[agentId]?.sessionsKind;
}
