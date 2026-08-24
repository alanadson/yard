/**
 * The environment a card's process is born with.
 *
 * Today that is one thing — the conversation cache lifetime, which Claude Code
 * reads from `ENABLE_PROMPT_CACHING_1H` and friends — but the shape is the
 * point: a PTY's environment is fixed at spawn, so it is read here, from the
 * card's own agent id, at each of the three places a process starts (the pane,
 * a card with no view, `yard recruit`).
 *
 * Deliberately **not** stored on the terminal row. The row is persisted, and a
 * copy of the setting living there would drift from Settings the moment the
 * user changed it — silently, since nothing on screen shows a process's
 * environment. Read at spawn means "restart the CLI" is what applies a change,
 * which is exactly what the row in Settings says.
 */
import { useAgentDefaults } from "../stores/agentDefaultsStore";
import { useProjects } from "../stores/projectsStore";

export function spawnEnvFor(terminalId: string): [string, string][] {
  const row = useProjects.getState().terminals.find((t) => t.id === terminalId);
  return useAgentDefaults.getState().envOf(row?.agentId ?? null);
}
