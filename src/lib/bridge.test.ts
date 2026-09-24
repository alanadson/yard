/**
 * The one seam of the bridge that crosses from one group to another:
 * `yard recruit "Nome" --floor "Frente"`.
 *
 * The pure rules of the CLI live in `bridgeCore.ts` and are tested there.
 * This file exists for a single thing the pure part cannot see: where the
 * recruit is born. A front is a project's group, and a project's group has
 * no canvas (the canvas is the boards, `lib/surface.ts`), so the recruit is a
 * **tab** of that front, and no rectangle is written for it anywhere. The
 * contract that changed: it used to be a card on the front's canvas, drawn
 * on a board the front could show; the front cannot show one any more, and a
 * card there would be a CLI nobody can see.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  spawnPty: vi.fn(async () => ({ id: "x", alive: true, cols: 120, rows: 38 })),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
  detectAgents: vi.fn(async () => []),
}));

vi.mock("./ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: vi.fn() }));
vi.mock("./roleBrief", () => ({ deliverBriefing: vi.fn() }));

import { handleBridgeRequest } from "./bridge";
import { EMPTY_CANVAS, type CanvasData } from "./canvas";
import { useAgentDefaults } from "../stores/agentDefaultsStore";
import { useProjects } from "../stores/projectsStore";

const PROJECT = "C:/proj";

beforeEach(() => {
  // `commitCanvasExternal` tells the mounted canvas to re-read itself. There
  // is no DOM here and the event has no listener either way.
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
  ipcMock.spawnPty.mockClear();
  useAgentDefaults.setState({ defaults: {} });
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
});

/** A project with one Claude Code card on the ground floor, the caller of every command. */
function seedCaller() {
  const s = useProjects.getState();
  const projectId = s.addProject("proj", PROJECT)!;
  const ground = s.groupsOf(projectId)[0];
  const caller = s.addTerminal({
    groupId: ground.id,
    title: "Claude",
    kind: "agent",
    agentId: "claude",
    program: "claude.exe",
    cwd: PROJECT,
  });
  return { s, projectId, ground, caller };
}

const request = (terminal: string, argv: string[]) =>
  handleBridgeRequest({ terminal, argv } as Parameters<typeof handleBridgeRequest>[0]);

/**
 * The regression: the terminal row was saved with the launch that
 * `launchOf` resolved (the fixed line from Configurações › Agentes, the WSL
 * wrapper, the hooks file), but the process itself was spawned with the raw
 * program and args. The card the user saw restart with the right line had
 * come up the first time without it, so the recruit asked for permissions the
 * user had already switched off. `--replace` did it right; the other two
 * branches did not.
 */
describe("the launch a recruit is spawned with", () => {
  it("is the resolved one, the same the row was saved with, on the caller's own floor", async () => {
    const { caller } = seedCaller();
    useAgentDefaults.getState().setConfig("claude", { args: "--dangerously-skip-permissions" });

    const res = await request(caller, ["recruit", "Nova"]);

    expect(res.code).toBe(0);
    const born = useProjects.getState().terminals.find((t) => t.title === "Nova")!;
    expect(born.args).toContain("--dangerously-skip-permissions");
    expect(ipcMock.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ id: born.id, program: born.program, args: born.args }),
    );
  });

  it("is the resolved one, the same the row was saved with, when born on another front", async () => {
    const { s, projectId, caller } = seedCaller();
    s.addGroup(projectId, "Frente", { activate: false });
    useAgentDefaults.getState().setConfig("claude", { args: "--dangerously-skip-permissions" });

    const res = await request(caller, ["recruit", "Nova", "--floor", "Frente"]);

    expect(res.code).toBe(0);
    const born = useProjects.getState().terminals.find((t) => t.title === "Nova")!;
    expect(born.args).toContain("--dangerously-skip-permissions");
    expect(ipcMock.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ id: born.id, program: born.program, args: born.args }),
    );
  });
});

/**
 * The regression: `String.replace` with a string replacement expands `$$`,
 * `$&`, `` $` `` and `$'`, so `yard note edit "Plano" "custo" "US$$ 5"` wrote
 * "US$ 5" and an agent pasting a shell snippet with `$&` got the matched text
 * back instead of the two characters it typed.
 */
describe("yard note edit", () => {
  it("writes the new text literally, even when it contains $$ and $&", async () => {
    const { s, ground, caller } = seedCaller();
    const canvas: CanvasData = {
      ...EMPTY_CANVAS,
      items: [
        { id: "n1", type: "note", x: 0, y: 0, w: 230, h: 170, text: "Plano\ncusto: x", color: "#fff" },
        { id: "w1", type: "connection", from: caller, to: "n1", color: "#fff" },
      ],
    };
    s.updateCanvas(ground.id, () => canvas);

    const res = await request(caller, ["note", "edit", "Plano", "custo: x", "custo: $$ e $&"]);

    expect(res.code).toBe(0);
    const note = useProjects
      .getState()
      .layoutOf(ground.id)
      .canvas?.items.find((i) => i.id === "n1");
    expect(note && "text" in note ? note.text : null).toBe("Plano\ncusto: $$ e $&");
  });
});

describe("recruiting onto another front", () => {
  it("is born a tab of that front, with no rectangle on any board: a front has no canvas", async () => {
    const s = useProjects.getState();
    const projectId = s.addProject("proj", PROJECT)!;
    const ground = s.groupsOf(projectId)[0];
    const caller = s.addTerminal({
      groupId: ground.id,
      title: "Claude",
      kind: "agent",
      agentId: "claude",
      program: "claude.exe",
      cwd: PROJECT,
    });
    const front = s.addGroup(projectId, "Frente", { activate: false });

    const res = await handleBridgeRequest({
      terminal: caller,
      argv: ["recruit", "Nova", "--floor", "Frente"],
    } as Parameters<typeof handleBridgeRequest>[0]);

    expect(res.code).toBe(0);
    const after = useProjects.getState();
    const born = after.terminalsOf(front).find((t) => t.title === "Nova");
    expect(born?.surface).toBe("grid");
    expect(after.layoutOf(front).canvas?.nodes ?? {}).toEqual({});
    // The answer says where it went, and does not send the caller to a
    // canvas that is not there.
    expect(res.output).toContain("aba");
    expect(res.output).not.toContain("canvas");
  });
});
