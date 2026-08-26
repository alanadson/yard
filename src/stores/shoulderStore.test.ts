/**
 * The Shoulder panel reads one session per agent of a group and shows the
 * digest of each. The rules that matter: only agents that write a session to
 * disk are read (the others say so instead of waiting forever, the bug the
 * overlay once had), a terminal without a trail says so, and one failed read
 * spoils its own row — never the whole panel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession, FeedEvent, TerminalRow } from "../lib/ipc";

const listAgentSessions = vi.fn(async (_agent: string, _cwd: string): Promise<AgentSession[]> => []);
const sessionEvents = vi.fn(async (_file: string): Promise<FeedEvent[]> => []);

vi.mock("../lib/ipc", () => ({
  ipc: {
    listAgentSessions: (...a: [string, string]) => listAgentSessions(...a),
    sessionEvents: (...a: [string]) => sessionEvents(...a),
    // The projects store remembers the active group through the kv on every change.
    writePref: async () => {},
  },
}));

const { useShoulder } = await import("./shoulderStore");
const { useProjects } = await import("./projectsStore");
const { useAgents } = await import("./agentsStore");

const row = (id: string, extra: Partial<TerminalRow> = {}): TerminalRow => ({
  id,
  groupId: "g1",
  slot: 0,
  surface: "grid",
  title: id,
  kind: "agent",
  agentId: "claude",
  program: "claude.cmd",
  args: [],
  cwd: "C:\\proj",
  resume: null,
  sort: 0,
  alive: true,
  createdAt: 1,
  ...extra,
});

const session = (externalId: string, updatedAt = 1): AgentSession => ({
  agent: "claude",
  externalId,
  projectPath: "C:\\proj",
  title: null,
  updatedAt,
  sizeBytes: 10,
  file: `C:\\s\\${externalId}.jsonl`,
});

const EVENTS: FeedEvent[] = [
  { kind: "prompt", at: 1, text: "arruma o login" },
  { kind: "tool", at: 2, tool: "Edit", op: "edit", path: "src/a.ts", toolId: "t1" },
  { kind: "say", at: 3, text: "pronto" },
];

beforeEach(() => {
  listAgentSessions.mockReset();
  sessionEvents.mockReset();
  listAgentSessions.mockResolvedValue([session("s1")]);
  sessionEvents.mockResolvedValue(EVENTS);
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [
      row("claude-1"),
      row("goose-1", { agentId: "goose", program: "goose.exe" }),
      row("shell-1", { kind: "shell", agentId: null, program: "pwsh.exe" }),
      row("other-group", { groupId: "g2" }),
    ],
    activeProjectId: null,
    activeGroupId: "g1",
  });
  useAgents.setState({
    loaded: true,
    byId: {
      claude: { id: "claude", name: "Claude Code", sessionsKind: "claude" } as never,
      goose: { id: "goose", name: "Goose", sessionsKind: null } as never,
    },
  });
  useShoulder.getState().clear();
});

describe("useShoulder.load", () => {
  it("digests the best session of each agent of the group, and says which ones cannot be read", async () => {
    await useShoulder.getState().load("g1");
    const rows = useShoulder.getState().rows;
    expect(rows.map((r) => r.terminalId)).toEqual(["claude-1", "goose-1"]);
    expect(rows[0].state).toBe("ready");
    expect(rows[0].digest?.turns).toBe(1);
    expect(rows[0].digest?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(rows[0].session?.externalId).toBe("s1");
    // Goose writes no session to disk: no listing, no wait.
    expect(rows[1].state).toBe("unsupported");
    expect(listAgentSessions).toHaveBeenCalledTimes(1);
    expect(listAgentSessions).toHaveBeenCalledWith("claude", "C:\\proj");
  });

  it("a terminal whose folder holds no trail says so instead of erroring", async () => {
    listAgentSessions.mockResolvedValue([]);
    await useShoulder.getState().load("g1");
    expect(useShoulder.getState().rows[0].state).toBe("none");
    expect(sessionEvents).not.toHaveBeenCalled();
  });

  it("a failed read spoils its own row, never the panel", async () => {
    useProjects.setState({
      terminals: [row("claude-1"), row("claude-2", { cwd: "C:\\other" })],
    });
    sessionEvents.mockImplementation(async (file: string) => {
      if (file.includes("s1")) throw new Error("disco fora");
      return EVENTS;
    });
    listAgentSessions.mockImplementation(async (_a: string, cwd: string) => [
      session(cwd === "C:\\other" ? "s2" : "s1"),
    ]);
    await useShoulder.getState().load("g1");
    const rows = useShoulder.getState().rows;
    expect(rows[0].state).toBe("error");
    expect(rows[0].error).toContain("disco fora");
    expect(rows[1].state).toBe("ready");
    expect(useShoulder.getState().loading).toBe(false);
  });

  it("the resume id in the terminal's command line picks the session", async () => {
    useProjects.setState({
      terminals: [row("claude-1", { resume: ["--resume", "old"] })],
    });
    listAgentSessions.mockResolvedValue([session("newest", 9), session("old", 1)]);
    await useShoulder.getState().load("g1");
    expect(useShoulder.getState().rows[0].session?.externalId).toBe("old");
    expect(sessionEvents).toHaveBeenCalledWith("C:\\s\\old.jsonl");
  });

  it("refresh re-reads the same group; clear forgets everything", async () => {
    await useShoulder.getState().load("g1");
    await useShoulder.getState().refresh();
    expect(sessionEvents).toHaveBeenCalledTimes(2);
    useShoulder.getState().clear();
    expect(useShoulder.getState().rows).toEqual([]);
    expect(useShoulder.getState().groupId).toBeNull();
  });
});
