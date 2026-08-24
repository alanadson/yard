/**
 * The cache choice reaches the CLI as an environment variable, and a PTY's
 * environment is fixed at spawn. So it is read here, from the card's own
 * agent id, at the three places a process is started — never persisted on the
 * row, which is what keeps "changed the setting" and "restarted the CLI" two
 * separate, visible steps instead of a silent drift.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  ipc: {
    saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
    writePref: vi.fn(async () => undefined),
  },
}));

import { spawnEnvFor } from "./spawnEnv";
import { useAgentDefaults } from "../stores/agentDefaultsStore";
import { useProjects } from "../stores/projectsStore";

function card(kind: "agent" | "shell", agentId: string | null): string {
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
  const projectId = useProjects.getState().addProject("P", "C:/x")!;
  const groupId = useProjects.getState().addGroup(projectId);
  return useProjects.getState().addTerminal({
    groupId,
    kind,
    agentId,
    program: agentId ?? "pwsh.exe",
    args: [],
    cwd: "C:/x",
  });
}

beforeEach(() => {
  useAgentDefaults.setState({ defaults: {} });
});

describe("spawnEnvFor", () => {
  it("carries what was configured for the card's agent", () => {
    const id = card("agent", "claude");
    useAgentDefaults.getState().setConfig("claude", { cache: "1h" });
    expect(spawnEnvFor(id)).toEqual([["ENABLE_PROMPT_CACHING_1H", "1"]]);
  });

  it("a shell has no agent, so it carries nothing", () => {
    const id = card("shell", null);
    useAgentDefaults.getState().setConfig("claude", { cache: "1h" });
    expect(spawnEnvFor(id)).toEqual([]);
  });

  it("a card that no longer exists is not a crash on the way to the PTY", () => {
    expect(spawnEnvFor("sumiu")).toEqual([]);
  });
});
