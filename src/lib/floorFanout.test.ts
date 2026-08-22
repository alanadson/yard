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

import { fanOutTask } from "./floorFanout";
import { useProjects } from "../stores/projectsStore";

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
