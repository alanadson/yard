/**
 * The fan-out creates N floors and brings up N agents. What happens when one
 * of them fails is the part the user saw wrong: the floors already created
 * were left behind without a mention, and a process that failed to come up
 * was swallowed — the final notice counted everyone as "up".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createFloor, startTerminalProcess, closeGroup, placeCard, deliverBriefing } =
  vi.hoisted(() => ({
    createFloor: vi.fn(),
    startTerminalProcess: vi.fn(),
    closeGroup: vi.fn(),
    placeCard: vi.fn(),
    deliverBriefing: vi.fn(),
  }));

vi.mock("./floorCreate", () => ({ createFloor }));
vi.mock("./lifecycle", () => ({ startTerminalProcess, closeGroup }));
vi.mock("./canvasWrite", () => ({ placeCard }));
vi.mock("./roleBrief", () => ({ deliverBriefing }));
vi.mock("./ipc", () => ({
  ipc: {
    saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
    writePref: vi.fn(async () => undefined),
  },
}));

import { agentAsFanout, fanOutTask } from "./floorFanout";
import { useAgentDefaults } from "../stores/agentDefaultsStore";
import { useProjects } from "../stores/projectsStore";

/** An `AgentInfo` as the detector would report it. */
function agentInfo(id: string, name: string, bin = `${id}.exe`) {
  return {
    id,
    name,
    bin,
    version: null,
    installed: true,
    resumeTemplate: null,
    continueArgs: null,
    sessionsKind: null,
    docs: null,
  };
}

const AGENTS = [
  { id: "claude", name: "Claude Code", program: "claude" },
  { id: "codex", name: "Codex", program: "codex" },
];

function project(): string {
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
  return useProjects.getState().addProject("P", "C:/Workspace/x")!;
}

/** A fake isolated floor, with a real group underneath. */
function floorOf(projectId: string, itemName: string) {
  const groupId = useProjects.getState().addGroup(projectId, itemName, { activate: false });
  return {
    groupId,
    provision: { kind: "isolated" as const, path: `C:/Workspace/x/.yard/${itemName}` },
  };
}

describe("fanOutTask", () => {
  beforeEach(() => {
    createFloor.mockReset();
    startTerminalProcess.mockReset();
    closeGroup.mockReset();
    startTerminalProcess.mockResolvedValue(undefined);
  });

  it("carries on with the others when a floor is not born, and counts the failure", async () => {
    const p = project();
    createFloor
      .mockRejectedValueOnce(new Error("branch já existe"))
      .mockImplementationOnce(async () => floorOf(p, "b"));

    const r = await fanOutTask({
      projectId: p,
      name: "tarefa",
      prompt: "faça",
      agents: AGENTS,
    });

    expect(r.floors).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("Claude Code");
  });

  it("counts as stopped the floor whose process did not come up", async () => {
    const p = project();
    createFloor
      .mockImplementationOnce(async () => floorOf(p, "a"))
      .mockImplementationOnce(async () => floorOf(p, "b"));
    startTerminalProcess
      .mockRejectedValueOnce(new Error("binário sumiu do PATH"))
      .mockResolvedValueOnce(undefined);

    const r = await fanOutTask({
      projectId: p,
      name: "tarefa",
      prompt: "faça",
      agents: AGENTS,
    });

    // The card is still there — the user's ▶ starts it — but it is not up.
    expect(r.floors).toHaveLength(2);
    expect(r.notStarted).toHaveLength(1);
    expect(r.failures[0]).toContain("não subiu");
  });

  it("without git, refuses the whole task and does not leave the group behind", async () => {
    const p = project();
    createFloor.mockImplementationOnce(async () => {
      const g = useProjects.getState().addGroup(p, "sem-git", { activate: false });
      return { groupId: g, provision: { kind: "plain" as const } };
    });

    await expect(
      fanOutTask({ projectId: p, name: "t", prompt: "faça", agents: AGENTS }),
    ).rejects.toThrow(/repositório git/);
    expect(closeGroup).toHaveBeenCalledTimes(1);
  });
});

/**
 * The fleet is the one place where nobody gets to tick a checkbox: N CLIs are
 * spawned in a loop, off screen. If the agent's fixed line did not reach them,
 * five agents would come up asking for permission with no terminal in view to
 * answer in.
 */
describe("the line configured in Settings", () => {
  it("reaches every agent of the fleet", async () => {
    const p = project();
    useAgentDefaults.setState({ defaults: {} });
    useAgentDefaults
      .getState()
      .setConfig("claude", { args: "--dangerously-skip-permissions" });
    createFloor.mockImplementationOnce(async () => floorOf(p, "t-claude"));

    await fanOutTask({
      projectId: p,
      name: "tarefa",
      prompt: "faça",
      agents: [agentAsFanout(agentInfo("claude", "Claude Code"))!],
    });

    expect(startTerminalProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ args: ["--dangerously-skip-permissions"] }),
    );
  });
});

/**
 * A fleet is spawned off screen, so "roda no WSL" has to survive the trip: the
 * process is `wsl.exe` and the worktree is where the agent lands. Getting this
 * wrong means N terminals that die on a Windows path inside a distro, with no
 * pane in view to read the error in.
 */
describe("an agent that lives in WSL", () => {
  it("is launched through wsl.exe, in its own worktree", async () => {
    const p = project();
    useAgentDefaults.setState({ defaults: {} });
    useAgentDefaults.getState().setConfig("claude", { where: "wsl", distro: "Ubuntu" });
    createFloor.mockImplementationOnce(async () => floorOf(p, "t-claude"));

    await fanOutTask({
      projectId: p,
      name: "tarefa",
      prompt: "faça",
      agents: [agentAsFanout(agentInfo("claude", "Claude Code", "claude.cmd"))!],
    });

    expect(startTerminalProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        program: "wsl.exe",
        args: ["-d", "Ubuntu", "--cd", "C:/Workspace/x/.yard/t-claude", "--", "claude"],
      }),
    );
  });
});

/**
 * The regression: a fan-out floor took whatever surface the group was
 * showing, and the ground clone used to turn a fresh floor to the canvas —
 * so five agents launched into five boards, each with one card on it. The
 * canvas is not where a fan-out lands.
 */
describe("where the agents land", () => {
  it("puts every agent in a pane and writes nothing to any canvas", async () => {
    const projectId = project();
    createFloor.mockImplementation(async () => {
      const groupId = useProjects.getState().addGroup(projectId, "frente", { activate: false });
      useProjects.getState().updateLayout(groupId, { surface: "canvas" });
      return { groupId, provision: { kind: "isolated", path: "C:/proj/.yard/floors/f" } };
    });

    const out = await fanOutTask({
      projectId,
      name: "tarefa",
      prompt: "faça",
      agents: AGENTS,
    });

    expect(out.failures).toEqual([]);
    const surfaces = out.floors.map((f) => useProjects.getState().terminal(f.terminalId)?.surface);
    expect(surfaces).toEqual(["grid", "grid"]);
    expect(placeCard).not.toHaveBeenCalled();
  });
});

describe("floorNameFor", () => {
  it("a fleet names its fronts after the task and the agent, so five are five", async () => {
    const { floorNameFor } = await import("./floorFanout");
    expect(floorNameFor({ name: "Login", agentName: "Claude Code" })).toBe("Login · Claude Code");
  });

  it("a single worker keeps the name it was given: the caller will address it by that", async () => {
    const { floorNameFor } = await import("./floorFanout");
    expect(floorNameFor({ name: "Login", agentName: "Claude Code", exact: true })).toBe("Login");
  });
});
