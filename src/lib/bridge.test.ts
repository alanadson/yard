/**
 * The one seam of the bridge that crosses from one group to another:
 * `yard recruit "Nome" --floor "Frente"`.
 *
 * The pure rules of the CLI live in `bridgeCore.ts` and are tested there.
 * This file exists for a single thing the pure part cannot see: a recruit is
 * a **card**, and this command always writes the card's rectangle onto the
 * front's canvas. It used to take the front's *current* surface for the row
 * itself, which was the same thing only while a new front happened to open on
 * the canvas. It does not any more (`lib/groundClone.ts`), so the two halves
 * disagreed: a tab in a pane, with a rectangle for it on a board where no
 * card was ever drawn.
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
  it("is born a card on that front's board, never a tab with a rectangle nobody drew", async () => {
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
      surface: "canvas",
    });
    const front = s.addGroup(projectId, "Frente", { activate: false });

    const res = await handleBridgeRequest({
      terminal: caller,
      argv: ["recruit", "Nova", "--floor", "Frente"],
    } as Parameters<typeof handleBridgeRequest>[0]);

    expect(res.code).toBe(0);
    const after = useProjects.getState();
    const born = after.terminalsOf(front).find((t) => t.title === "Nova");
    expect(born?.surface).toBe("canvas");
    // The rectangle and the row agree: the card the command drew is the row
    // it created.
    expect(Object.keys(after.layoutOf(front).canvas?.nodes ?? {})).toEqual([born!.id]);
  });
});
