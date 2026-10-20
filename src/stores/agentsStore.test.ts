/** A slower discovery pass must not replace newer executable and version diagnostics. */
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentInfo } from "../lib/ipc";
const detectAgents = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", () => ({ ipc: { detectAgents } }));
import { useAgents } from "./agentsStore";

beforeEach(() => { detectAgents.mockReset(); useAgents.setState({ byId: {}, loaded: false, error: null }); });

it("keeps discovery visibly pending until the native result arrives", async () => {
  let finish!: (agents: AgentInfo[]) => void;
  detectAgents.mockImplementationOnce(() => new Promise<AgentInfo[]>((resolve) => { finish = resolve; }));
  const pending = useAgents.getState().load(true);
  expect.soft(useAgents.getState().loading).toBe(true);
  finish([]);
  await pending;
  expect(useAgents.getState().loading).toBe(false);
});

it("reports a failed discovery while retaining the last known executable diagnostics", async () => {
  const agent: AgentInfo = { id: "claude", name: "Claude Code", installed: true, bin: "C:/tools/claude.cmd", version: "known version",
    resumeTemplate: null, continueArgs: null, sessionsKind: null, docs: null };
  useAgents.setState({ byId: { claude: agent }, loaded: true });
  detectAgents.mockRejectedValueOnce(new Error("Detection unavailable"));
  await useAgents.getState().load(true);
  expect(useAgents.getState().byId.claude).toEqual(agent);
  expect(useAgents.getState().error).toBe("Detection unavailable");
});

it("keeps the refreshed executable version when an older discovery finishes afterward", async () => {
  let oldResult!: (agents: AgentInfo[]) => void;
  let newResult!: (agents: AgentInfo[]) => void;
  detectAgents.mockImplementationOnce(() => new Promise<AgentInfo[]>((resolve) => { oldResult = resolve; }));
  detectAgents.mockImplementationOnce(() => new Promise<AgentInfo[]>((resolve) => { newResult = resolve; }));
  useAgents.setState({ byId: {}, loaded: false });
  const before = useAgents.getState().load();
  const refresh = useAgents.getState().load(true);
  const agent: AgentInfo = { id: "claude", name: "Claude Code", installed: true, bin: "C:/tools/claude.cmd", version: "new version",
    resumeTemplate: null, continueArgs: null, sessionsKind: null, docs: null };
  newResult([agent]);
  await refresh;
  oldResult([{ ...agent, version: "old version", bin: "C:/old/claude.cmd" }]);
  await before;
  expect(useAgents.getState().byId.claude.version).toBe("new version");
  expect(useAgents.getState().byId.claude.bin).toBe("C:/tools/claude.cmd");
});
