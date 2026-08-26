/**
 * Which session on disk is a terminal's.
 *
 * Sessions are listed by *folder* — two CLIs in the same project write two
 * trails there — so the only certain link is the id a resumed terminal
 * carries in its command line (`--resume <id>`). Without it, the newest trail
 * is the best guess, the same one "Ao Vivo" starts from.
 */
import type { AgentSession } from "./ipc";

/** The backend lists newest first; a resume id in the args beats recency. */
export function bestSessionFor(
  sessions: readonly AgentSession[],
  resumeArgs: readonly string[] | null | undefined,
): AgentSession | null {
  const hinted = resumeArgs?.length
    ? sessions.find((s) => resumeArgs.includes(s.externalId))
    : undefined;
  return hinted ?? sessions[0] ?? null;
}
