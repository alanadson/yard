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
import { goToTerminal } from "./navigate";
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
  });
  useTerminals.setState({ byId: {} });
  useUI.setState({ focusedTerminalId: null, canvasReveal: null });

  const p = useProjects.getState().addProject("P", "C:/Workspace/x")!;
  const g = useProjects.getState().addGroup(p, "G");
  useProjects.getState().updateLayout(g, { mode });
  const create = (title: string) =>
    useProjects.getState().addTerminal({
      groupId: g,
      program: "pwsh",
      cwd: "C:/Workspace/x",
      title,
    });
  return { g, t1: create("um"), t2: create("dois"), t3: create("tres") };
}

describe("goToTerminal", () => {
  it("in the grid, brings the tab to the front and focuses the terminal", () => {
    const { g, t1, t3 } = build("auto");
    // The active tab is the last one created; the target is another.
    expect(useProjects.getState().layoutOf(g).activeBySlot[0]).toBe(t3);

    goToTerminal(useProjects.getState().terminal(t1)!);

    expect(useProjects.getState().layoutOf(g).activeBySlot[0]).toBe(t1);
    expect(useUI.getState().focusedTerminalId).toBe(t1);
    expect(useProjects.getState().activeGroupId).toBe(g);
  });

  it("on the canvas, asks the camera to reveal the card", () => {
    const { g, t1 } = build("canvas");

    goToTerminal(useProjects.getState().terminal(t1)!);

    expect(useUI.getState().canvasReveal).toEqual({ groupId: g, id: t1 });
    expect(useUI.getState().focusedTerminalId).toBe(t1);
  });
});

describe("jumpToAttention", () => {
  it("serves whoever is blocked first, then whoever finished", () => {
    const { t1, t2, t3 } = build("auto");
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
    const { t1 } = build("auto");
    useTerminals.setState({ byId: { [t1]: { ...RUNTIME } } });
    useUI.setState({ toasts: [], focusedTerminalId: null });

    jumpToAttention();

    expect(useUI.getState().focusedTerminalId).toBeNull();
    expect(useUI.getState().toasts).toHaveLength(1);
  });
});
