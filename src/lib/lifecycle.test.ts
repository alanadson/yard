/**
 * Deleting a CLI has to leave the group in the same state no matter which
 * door it came through.
 *
 * The canvas cleanup used to live only in `yard dismiss`, so closing the tab
 * kept the card, its role, its routines and every wire pointing at it inside
 * the group's `layoutJson` — invisible (a connection with a missing endpoint
 * simply is not drawn) and permanent. That is exactly the kind of wiring that
 * regresses without a test, because nothing on screen shows it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ptyExists, killPty, forgetPty, saveWorkspace } = vi.hoisted(() => ({
  ptyExists: vi.fn(async () => false),
  killPty: vi.fn(async () => undefined),
  forgetPty: vi.fn(async () => undefined),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 2 })),
}));

vi.mock("./ipc", () => ({
  ipc: {
    ptyExists,
    killPty,
    forgetPty,
    saveWorkspace,
    loadWorkspace: vi.fn(),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
    writePref: vi.fn(async () => undefined),
    listPtys: vi.fn(async () => []),
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));

import { closeTerminal } from "./lifecycle";
import { DEFAULT_LAYOUT, useProjects } from "../stores/projectsStore";
import type { CanvasData } from "./canvas";
import type { TerminalRow } from "./ipc";

// `commitCanvasExternal` announces the write on the window so `CanvasView`
// can drop its undo stack. The node test environment has no window.
vi.stubGlobal("window", { dispatchEvent: vi.fn() });

function term(id: string): TerminalRow {
  return {
    id,
    groupId: "g1",
    slot: 0,
    title: id,
    kind: "agent",
    agentId: "claude",
    program: "claude.cmd",
    args: [],
    cwd: "C:/proj",
    resume: null,
    sort: 0,
    alive: false,
    createdAt: 1,
  };
}

const canvas: CanvasData = {
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: {
    t1: { x: 0, y: 0, w: 420, h: 260 },
    t2: { x: 500, y: 0, w: 420, h: 260 },
  },
  roles: { t1: { name: "revisora" }, t2: { name: "implementadora" } },
  routines: [
    {
      id: "r1",
      terminalId: "t1",
      text: "rode os testes",
      everyMin: 30,
      enabled: true,
      createdAt: 0,
    },
    {
      id: "r2",
      terminalId: "t2",
      text: "revise",
      everyMin: 30,
      enabled: true,
      createdAt: 0,
    },
  ],
  items: [
    { id: "n1", type: "note", x: 0, y: 0, w: 200, h: 150, text: "briefing", color: "#f5f5f5" },
    { id: "c1", type: "connection", from: "t1", to: "t2", color: "#6b6b6b" },
    { id: "c2", type: "connection", from: "t1", to: "n1", color: "#6b6b6b" },
    { id: "c3", type: "connection", from: "t2", to: "n1", color: "#6b6b6b" },
  ],
};

describe("closeTerminal", () => {
  beforeEach(() => {
    saveWorkspace.mockClear();
    useProjects.setState({
      rev: 1,
      loaded: true,
      projects: [
        { id: "p1", name: "P", path: "C:/proj", sort: 0, createdAt: 0 },
      ],
      groups: [
        {
          id: "g1",
          projectId: "p1",
          name: "Principal",
          layoutJson: JSON.stringify({ ...DEFAULT_LAYOUT, canvas }),
          suspended: false,
          sort: 0,
        },
      ],
      terminals: [term("t1"), term("t2")],
      activeProjectId: "p1",
      activeGroupId: "g1",
    });
  });

  it("takes the terminal's card, role, routines and wires with it", async () => {
    await closeTerminal("t1");

    const c = useProjects.getState().layoutOf("g1").canvas!;
    expect(Object.keys(c.nodes)).toEqual(["t2"]);
    expect(c.roles).toEqual({ t2: { name: "implementadora" } });
    expect(c.routines?.map((r) => r.id)).toEqual(["r2"]);
    // The two cables touching t1 disappear; the one from t2 to the note stays.
    expect(c.items.map((i) => i.id)).toEqual(["n1", "c3"]);
  });

  it("does not touch what belongs to the others", async () => {
    await closeTerminal("t1");

    const s = useProjects.getState();
    expect(s.terminals.map((t) => t.id)).toEqual(["t2"]);
    const note = s.layoutOf("g1").canvas!.items.find((i) => i.id === "n1");
    expect(note).toMatchObject({ type: "note", text: "briefing" });
  });

  it("kills the process before releasing the workspace row", async () => {
    ptyExists.mockResolvedValueOnce(true);
    await closeTerminal("t2");

    expect(killPty).toHaveBeenCalledWith("t2");
    expect(forgetPty).toHaveBeenCalledWith("t2");
    expect(useProjects.getState().terminal("t2")).toBeUndefined();
  });

  it("an id that no longer exists neither breaks nor deletes anything", async () => {
    await closeTerminal("fantasma");

    const c = useProjects.getState().layoutOf("g1").canvas!;
    expect(Object.keys(c.nodes).sort()).toEqual(["t1", "t2"]);
    expect(useProjects.getState().terminals).toHaveLength(2);
  });
});
