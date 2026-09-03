/**
 * What is configured for each CLI, in memory.
 *
 * One kv key holding `{ "claude": "--dangerously-skip-permissions" }` — or the
 * record form, once there is more to say than the line. The rules (how the
 * blob is sifted, how a line becomes an `argv`, which environment a cache
 * choice writes) live in `lib/agentDefaults.ts`; this store only remembers and
 * persists them.
 *
 * It is hydrated at boot, from the same snapshot every other preference-backed
 * store reads, because the readers have no `await` to spend: `yard recruit`
 * builds its argv in the middle of a command, and a fan-out spawns N processes
 * in a loop.
 */
import { create } from "zustand";

import {
  cacheEnvOf,
  configOf,
  defaultArgvOf,
  launchFor,
  parseAgentDefaults,
  serializeAgentDefaults,
  withAgentConfig,
  type AgentConfig,
  type AgentDefaults,
  type Launch,
} from "../lib/agentDefaults";
import { ipc } from "../lib/ipc";
import { persistJsonPref, readPrefs, type PrefsSnapshot } from "../lib/prefs";
import { useUI } from "./uiStore";

export const KV_AGENT_DEFAULTS = "agents.defaults";

interface AgentDefaultsState {
  defaults: AgentDefaults;
  /** `<data>\bin\claude-hooks.json`, once the backend answered; `null` before. */
  hooksFile: string | null;
  load: (prefs?: PrefsSnapshot) => Promise<void>;
  /** Changes part of one agent's config. */
  setConfig: (id: string, patch: Partial<AgentConfig>) => void;
  /** Sets one agent's fixed line — the most common single change. */
  setLine: (id: string, line: string) => void;
  /** The tokens a spawn adds to the command line of that agent. */
  argvOf: (id: string | null | undefined) => string[];
  /** The environment a card of that agent is spawned with. */
  envOf: (id: string | null | undefined) => [string, string][];
  /** The launch of a card: wrapped in `wsl.exe` when the agent lives there. */
  launchOf: (
    id: string | null | undefined,
    launch: Launch & { cwd: string },
  ) => Launch;
}

export const useAgentDefaults = create<AgentDefaultsState>((set, get) => ({
  defaults: {},
  hooksFile: null,

  load: async (prefs) => {
    try {
      const raw = prefs ?? (await readPrefs());
      set({ defaults: parseAgentDefaults(raw[KV_AGENT_DEFAULTS]) });
    } catch (e) {
      console.warn("[yard] não consegui ler os padrões dos agentes", e);
    }
    // Where Claude Code's hooks file is: asked once, kept for every launch.
    // Failing (a test, an older backend) only means no hooks on the line.
    try {
      const path = await ipc.bridgeHooksFile();
      if (path) set({ hooksFile: path });
    } catch {
      set({ hooksFile: null });
    }
  },

  setConfig: (id, patch) => {
    const defaults = withAgentConfig(get().defaults, id, patch);
    set({ defaults });
    persistJsonPref(KV_AGENT_DEFAULTS, serializeAgentDefaults(defaults), (error) =>
      console.warn(`[yard] não consegui gravar ${KV_AGENT_DEFAULTS}`, error),
    );
  },

  setLine: (id, line) => get().setConfig(id, { args: line }),

  argvOf: (id) => defaultArgvOf(get().defaults, id),
  envOf: (id) => cacheEnvOf(get().defaults, id),
  launchOf: (id, launch) =>
    launchFor(get().defaults, id, launch, {
      enabled: useUI.getState().prefs.agentHooks,
      claudeSettings: get().hooksFile,
    }),
}));

/** Read-only helper for the callers that only need one field. */
export function agentConfig(id: string | null | undefined): AgentConfig {
  return configOf(useAgentDefaults.getState().defaults, id);
}
