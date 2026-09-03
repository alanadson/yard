/**
 * A score is an arrangement of the canvas: cards, wires, roles, notes. The
 * canvas is the boards (`lib/surface.ts`), so a score lands on a board and
 * nowhere else. What it cannot carry is a folder: the saved file has no
 * project, and a board has none either, so the cards run where the board's
 * last card ran, or where the caller says.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
}));

vi.mock("./ipc", () => ({ ipc: ipcMock }));

import { applyScore, type ScoreFile } from "./scores";
import { useProjects } from "../stores/projectsStore";

const score: ScoreFile = {
  v: 1,
  name: "dupla",
  savedAt: 0,
  terminals: [
    { key: "a", title: "Claude", kind: "agent", agentId: "claude", program: "claude.exe", args: [] },
  ],
  canvas: {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: { a: { x: 0, y: 0, w: 640, h: 400 } },
    items: [],
  },
};

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

describe("applyScore", () => {
  it("refuses a project's group: a score is an arrangement of the canvas, which only a board has", () => {
    const s = useProjects.getState();
    const projectId = s.addProject("proj", "C:/proj")!;
    const ground = s.groupsOf(projectId)[0].id;

    expect(() => applyScore(score, ground)).toThrow(/quadro/);
    expect(useProjects.getState().terminalsOf(ground)).toHaveLength(0);
  });

  it("lands on a board as cards, in the folder the board's last card was given", () => {
    const s = useProjects.getState();
    const board = s.addBoard("Quadro");
    s.addTerminal({ groupId: board, program: "pwsh", cwd: "C:/Workspace/x" });

    const r = applyScore(score, board);

    expect(r.terminals).toBe(1);
    const after = useProjects.getState();
    const born = after.terminalsOn(board, "canvas").find((t) => t.title === "Claude")!;
    expect(born.cwd).toBe("C:/Workspace/x");
    expect(after.layoutOf(board).canvas?.nodes[born.id]).toBeTruthy();
  });

  it("a folder given by the caller wins over the board's", () => {
    const s = useProjects.getState();
    const board = s.addBoard("Quadro");
    s.addTerminal({ groupId: board, program: "pwsh", cwd: "C:/Workspace/x" });

    applyScore(score, board, { cwd: "D:/outra" });

    const born = useProjects.getState().terminalsOn(board, "canvas").find((t) => t.title === "Claude")!;
    expect(born.cwd).toBe("D:/outra");
  });
});
