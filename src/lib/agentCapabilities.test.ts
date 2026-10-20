/** Integration diagnostics describe Yard adapters rather than inferring features from a CLI's name. */
import { expect, it } from "vitest";
import * as capabilities from "./agentCapabilities";
import type { AgentInfo } from "./ipc";

const agent: AgentInfo = { id: "claude", name: "Claude Code", installed: true, bin: "C:/tools/claude.cmd", version: "2.1",
  resumeTemplate: "--resume {}", continueArgs: ["--continue"], sessionsKind: "claude", docs: null };

it("reports the locally configured resume, transcript, MCP and hook adapters for a detected agent", () => {
  expect(capabilities.agentCapabilities(agent, "windows")).toEqual({ resume: true, continue: true, transcript: true, mcp: true, hooks: true, usageLimits: true });
});

it.each(["wsl", "ssh"] as const)("does not advertise local session, account, MCP or hook integrations as connected to %s", (where) => {
  expect(capabilities.agentCapabilities(agent, where)).toEqual({ resume: true, continue: true, transcript: false, mcp: false, hooks: false, usageLimits: false });
});

it("does not infer adapters from a display name when catalog metadata is absent or describes a custom CLI", () => {
  const custom = { ...agent, id: "custom", name: "Claude Code", resumeTemplate: null, continueArgs: null, sessionsKind: null };
  const unsupported = { resume: false, continue: false, transcript: false, mcp: false, hooks: false, usageLimits: false };
  expect(capabilities.agentCapabilities(custom, "windows")).toEqual(unsupported);
  expect(capabilities.agentCapabilities(undefined, "windows")).toEqual(unsupported);
});
