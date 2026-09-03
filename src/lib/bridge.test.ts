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
import { useProjects } from "../stores/projectsStore";

const PROJECT = "C:/proj";

beforeEach(() => {
  // `commitCanvasExternal` tells the mounted canvas to re-read itself. There
  // is no DOM here and the event has no listener either way.
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
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
