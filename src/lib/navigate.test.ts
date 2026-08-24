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
import { type Surface } from "./surface";
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

function build(surface: Surface = "grid", mode: LayoutMode = "auto") {
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
  useProjects.getState().updateLayout(g, { mode, surface });
  const create = (title: string) =>
    useProjects.getState().addTerminal({
      groupId: g,
      program: "pwsh",
      cwd: "C:/Workspace/x",
      title,
      surface,
    });
  return { g, t1: create("um"), t2: create("dois"), t3: create("tres") };
}

describe("goToTerminal", () => {
  it("in the grid, brings the tab to the front and focuses the terminal", () => {
    const { g, t1, t3 } = build("grid");
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

  /**
   * Each terminal now lives on one surface only, so "take me to it" has to
   * take the *screen* there too — landing on the other surface with "found
   * it!" and nothing visible is the bug this whole file exists to prevent.
   */
  it("a card pulls the group onto the canvas, even with the panes up", () => {
    const { g, t1 } = build("canvas");
    useProjects.getState().updateLayout(g, { surface: "grid" });

    goToTerminal(useProjects.getState().terminal(t1)!);

    expect(useProjects.getState().layoutOf(g).surface).toBe("canvas");
    expect(useUI.getState().canvasReveal).toEqual({ groupId: g, id: t1 });
  });

  it("a tab pulls the group back to the panes, even with the board up", () => {
    const { g, t1 } = build("grid");
    useProjects.getState().updateLayout(g, { mode: "spotlight", surface: "canvas" });

    goToTerminal(useProjects.getState().terminal(t1)!);

    const layout = useProjects.getState().layoutOf(g);
    expect(layout.surface).toBe("grid");
    // The grid the user had pinned survives the trip — the two are separate now.
    expect(layout.mode).toBe("spotlight");
    expect(layout.activeBySlot[0]).toBe(t1);
    expect(useUI.getState().focusedTerminalId).toBe(t1);
  });
});

describe("jumpToAttention", () => {
  it("serves whoever is blocked first, then whoever finished", () => {
    const { t1, t2, t3 } = build("grid");
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
    const { t1 } = build("grid");
    useTerminals.setState({ byId: { [t1]: { ...RUNTIME } } });
    useUI.setState({ toasts: [], focusedTerminalId: null });

    jumpToAttention();

    expect(useUI.getState().focusedTerminalId).toBeNull();
    expect(useUI.getState().toasts).toHaveLength(1);
  });
});
