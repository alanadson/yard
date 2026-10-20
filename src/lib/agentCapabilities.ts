/** Capability rows describe integrations implemented in Yard, separately from CLI availability. */
import type { AgentInfo } from "./ipc";
import type { AgentWhere } from "./agentDefaults";
import { MCP_SUPPORTED } from "./mcp";

export interface AgentCapabilities {
  resume: boolean;
  continue: boolean;
  transcript: boolean;
  mcp: boolean;
  hooks: boolean;
  usageLimits: boolean;
}

export function agentCapabilities(agent: AgentInfo | null | undefined, where: AgentWhere): AgentCapabilities {
  const id = agent?.id ?? "";
  const local = where === "windows";
  return {
    resume: !!agent?.resumeTemplate,
    continue: !!agent?.continueArgs?.length,
    transcript: local && !!agent?.sessionsKind,
    mcp: local && (MCP_SUPPORTED as readonly string[]).includes(id),
    hooks: local && ["claude", "codex"].includes(id),
    usageLimits: local && ["claude", "codex", "grok"].includes(id),
  };
}
