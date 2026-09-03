import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  ipc: {
    saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
    loadWorkspace: vi.fn(),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
    writePref: vi.fn(async () => undefined),
  },
}));

import { jumpToAttention } from "./attention";
import { goToTerminal, toggleCanvas } from "./navigate";
import { useProjects, type LayoutMode } from "../stores/projectsStore";
import { useTerminals, type TerminalRuntime } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";

const RUNTIME: TerminalRuntime = {
  state: "running",
  pid: 1,
  exit: null,
  error: null,
  unread: false,
  finished: false,
  finishedAt: 0,
  blocked: false,
  blockedAsk: null,
  permission: false,
  rssMb: 0,
  cpu: 0,
};

function build(mode: LayoutMode = "auto") {
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
    groupBeforeBoard: null,
    lastBoardId: null,
    canvasSide: false,
  });
  useTerminals.setState({ byId: {} });
  useUI.setState({ focusedTerminalId: null, canvasReveal: null });

  // A project's group, which holds tabs, and a board, which holds cards: the
  // canvas is the boards, so a card has no other place to be.
  const p = useProjects.getState().addProject("P", "C:/Workspace/x")!;
  const g = useProjects.getState().addGroup(p, "G");
  useProjects.getState().updateLayout(g, { mode });
  const b = useProjects.getState().addBoard("Quadro");
  useProjects.getState().setActiveGroup(g);
  const create = (groupId: string, title: string) =>
    useProjects.getState().addTerminal({
      groupId,
      program: "pwsh",
      cwd: "C:/Workspace/x",
      title,
    });
  return { g, b, t1: create(g, "um"), t2: create(g, "dois"), t3: create(g, "tres"), c1: create(b, "cartao") };
}

describe("goToTerminal", () => {
  it("in the grid, brings the tab to the front and focuses the terminal", () => {
    const { g, t1, t3 } = build();
    // The active tab is the last one created; the target is another.
    expect(useProjects.getState().layoutOf(g).activeBySlot[0]).toBe(t3);

    goToTerminal(useProjects.getState().terminal(t1)!);

    expect(useProjects.getState().layoutOf(g).activeBySlot[0]).toBe(t1);
    expect(useUI.getState().focusedTerminalId).toBe(t1);
    expect(useProjects.getState().activeGroupId).toBe(g);
  });

  it("on a board, asks the camera to reveal the card", () => {
    const { b, c1 } = build();
    useProjects.getState().setActiveGroup(b);

    goToTerminal(useProjects.getState().terminal(c1)!);

    expect(useUI.getState().canvasReveal).toEqual({ groupId: b, id: c1 });
    expect(useUI.getState().focusedTerminalId).toBe(c1);
  });

  /**
   * Each terminal lives on one surface only, so "take me to it" has to take
   * the *screen* there too: landing somewhere else with "found it!" and
   * nothing visible is the bug this whole file exists to prevent. The
   * contract that changed: the trip used to flip the group's own surface;
   * a card's surface is its board now, so the trip is a change of group.
   */
  it("a card takes the screen to its board, even from a project's panes", () => {
    const { b, c1 } = build();

    goToTerminal(useProjects.getState().terminal(c1)!);

    expect(useProjects.getState().activeGroupId).toBe(b);
    expect(useUI.getState().canvasReveal).toEqual({ groupId: b, id: c1 });
  });

  it("a tab takes the screen back to its group, even from a board", () => {
    const { g, b, t1 } = build("spotlight");
    useProjects.getState().setActiveGroup(b);

    goToTerminal(useProjects.getState().terminal(t1)!);

    expect(useProjects.getState().activeGroupId).toBe(g);
    const layout = useProjects.getState().layoutOf(g);
    expect(layout.surface).toBe("grid");
    // The grid the user had pinned survives the trip.
    expect(layout.mode).toBe("spotlight");
    expect(layout.activeBySlot[0]).toBe(t1);
    expect(useUI.getState().focusedTerminalId).toBe(t1);
  });
});

describe("jumpToAttention", () => {
  it("serves whoever is blocked first, then whoever finished", () => {
    const { t1, t2, t3 } = build();
    useTerminals.setState({
      byId: {
        // Board order is t1, t2, t3 — the queue does not follow that order.
        [t1]: { ...RUNTIME, finished: true },
        [t2]: { ...RUNTIME },
        [t3]: { ...RUNTIME, finished: true, blocked: true, blockedAsk: "(y/N)" },
      },
    });

    jumpToAttention();
    expect(useUI.getState().focusedTerminalId).toBe(t3);

    jumpToAttention();
    expect(useUI.getState().focusedTerminalId).toBe(t1);
  });

  it("with nobody waiting, warns instead of jumping", () => {
    const { t1 } = build();
    useTerminals.setState({ byId: { [t1]: { ...RUNTIME } } });
    useUI.setState({ toasts: [], focusedTerminalId: null });

    jumpToAttention();

    expect(useUI.getState().focusedTerminalId).toBeNull();
    expect(useUI.getState().toasts).toHaveLength(1);
  });
});

/**
 * The regression this locks down: the app was left with every group closed —
 * the screen the workspace shows as "escolha um grupo para começar" — and the
 * canvas had no door at all. The sidebar's row was gated on there being a
 * group, the title bar's button had just left, and the palette's row is gated
 * the same way. The canvas, with the boards inside it that belong to no
 * project, was unreachable.
 */
describe("toggleCanvas", () => {
  function emptyWorkspace() {
    useProjects.setState({
      rev: 1,
      loaded: true,
      projects: [],
      groups: [],
      terminals: [],
      activeProjectId: null,
      activeGroupId: null,
      groupBeforeBoard: null,
      lastBoardId: null,
      canvasSide: false,
    });
    return useProjects.getState().addProject("P", "C:/Workspace/canvas-door")!;
  }

  it("with no group open at all, it still puts the canvas on screen", () => {
    const p = emptyWorkspace();
    useProjects.setState({ groups: [], activeGroupId: null, activeProjectId: p });

    toggleCanvas();

    const s = useProjects.getState();
    expect(s.activeGroupId).not.toBeNull();
    expect(s.isBoard(s.activeGroupId!)).toBe(true);
    expect(s.layoutOf(s.activeGroupId!).surface).toBe("canvas");
  });

  it("with no group open it takes the board already there instead of making another", () => {
    const p = emptyWorkspace();
    const board = useProjects.getState().addBoard("Quadro");
    useProjects.setState({ activeGroupId: null, activeProjectId: p, canvasSide: false });

    toggleCanvas();

    expect(useProjects.getState().activeGroupId).toBe(board);
    expect(useProjects.getState().boards()).toHaveLength(1);
  });

  it("pressed again with no panes behind it, it comes back to the empty state", () => {
    const p = emptyWorkspace();
    useProjects.setState({ groups: [], activeGroupId: null, activeProjectId: p });

    toggleCanvas();
    toggleCanvas();

    expect(useProjects.getState().activeGroupId).toBeNull();
  });

  /**
   * The contract that changed: the door used to flip the active group's own
   * surface. A project's group has no canvas any more, so the door leads to
   * a board and, pressed again, back to the group it left.
   */
  it("from a project's group it goes to a board, and pressed again comes back to that group", () => {
    const { g, b } = build();

    toggleCanvas();
    expect(useProjects.getState().activeGroupId).toBe(b);
    expect(useProjects.getState().layoutOf(g).surface).toBe("grid");

    toggleCanvas();
    expect(useProjects.getState().activeGroupId).toBe(g);
  });

  it("it opens the board visited last, not the first in the bar", () => {
    const { g, b } = build();
    const second = useProjects.getState().addBoard("Dois");
    useProjects.getState().setActiveGroup(g);

    toggleCanvas();

    expect(useProjects.getState().activeGroupId).toBe(second);
    expect(b).not.toBe(second);
  });
});
