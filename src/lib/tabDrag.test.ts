/**
 * Moving a tab between panes touches three stores at once; what this file
 * guards is the seam — the pane the tab left must not keep pointing at it,
 * and the drop position must survive the translation into each store's
 * ordering (array order for docs, `sort` for terminals).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  ipc: {
    writePref: vi.fn(async () => undefined),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  },
  on: {},
}));

vi.mock("./log", () => ({
  uiLog: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { paneTabs } from "./paneTabs";
import { moveTab, moveTabBy } from "./tabDrag";
import { useBrowsers } from "../stores/browsersStore";
import { useEditor, docId, type OpenDoc } from "../stores/editorStore";
import { useProjects } from "../stores/projectsStore";
import type { TerminalRow } from "./ipc";

const group = (activeBySlot: Record<number, string>) => ({
  id: "g1",
  projectId: "p1",
  name: "G",
  layoutJson: JSON.stringify({ mode: "auto", panelCount: 2, activeBySlot }),
  suspended: false,
  sort: 0,
});

const term = (id: string, slot: number, sort: number): TerminalRow => ({
  id,
  groupId: "g1",
  slot,
  title: id,
  kind: "shell",
  agentId: null,
  program: "pwsh",
  args: [],
  cwd: "C:/x",
  resume: null,
  sort,
  alive: false,
  createdAt: 0,
});

function doc(path: string, slot: number): OpenDoc {
  const root = "C:\\proj";
  return {
    id: docId(root, path),
    projectId: "p1",
    groupId: "g1",
    slot,
    root,
    path,
    text: "x",
    saved: "x",
    diskVersion: 1,
    modifiedAt: 0,
    crlf: false,
    savedCrlf: false,
    encoding: "utf-8",
    bom: false,
    binary: false,
    truncated: false,
    lossy: false,
    size: 1,
    media: null,
    stale: false,
    missing: false,
    error: null,
    saving: false,
  };
}

beforeEach(() => {
  useProjects.setState({
    rev: 1,
    loaded: false,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: "p1",
    activeGroupId: "g1",
  });
  useEditor.setState({ docs: [], activeId: null, open: false });
  useBrowsers.setState({ tabs: [] });
});

describe("moveTab", () => {
  it("moving a file to another pane hands the source bar over to the neighbour", () => {
    const a = doc("src/a.ts", 0);
    useProjects.setState({
      groups: [group({ 0: a.id })],
      terminals: [term("t1", 0, 0)],
    });
    useEditor.setState({ docs: [a], activeId: a.id });

    moveTab("doc", a.id, "g1", 1, null);

    const moved = useEditor.getState().docs[0];
    expect(moved.slot).toBe(1);
    const { activeBySlot } = useProjects.getState().layoutOf("g1");
    expect(activeBySlot[0]).toBe("t1");
    expect(activeBySlot[1]).toBe(a.id);
  });

  it("a pane left with no tabs stops pointing at the one that left", () => {
    const a = doc("src/a.ts", 0);
    useProjects.setState({ groups: [group({ 0: a.id })] });
    useEditor.setState({ docs: [a], activeId: a.id });

    moveTab("doc", a.id, "g1", 1, null);

    const { activeBySlot } = useProjects.getState().layoutOf("g1");
    expect(activeBySlot[0]).toBeUndefined();
    expect(activeBySlot[1]).toBe(a.id);
  });

  it("dropping before another tab reorders the bar", () => {
    const a = doc("src/a.ts", 0);
    const b = doc("src/b.ts", 0);
    useProjects.setState({ groups: [group({ 0: a.id })] });
    useEditor.setState({ docs: [a, b], activeId: a.id });

    moveTab("doc", b.id, "g1", 0, a.id);

    expect(useEditor.getState().docs.map((d) => d.path)).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
    expect(useEditor.getState().activeId).toBe(b.id);
  });

  it("a CLI dropped on a file lands between the files", () => {
    // The bar takes a drop anywhere: the kinds are a default order, not
    // sections with walls between them.
    const compose = doc("docker-compose.yml", 0);
    const agents = doc("AGENTS.md", 0);
    useProjects.setState({
      groups: [group({ 0: "t1" })],
      terminals: [term("t1", 0, 0)],
    });
    useEditor.setState({ docs: [compose, agents], activeId: null });

    moveTab("terminal", "t1", "g1", 0, agents.id);

    expect(paneTabs("g1", 0).map((t) => t.id)).toEqual([
      compose.id,
      "t1",
      agents.id,
    ]);
  });

  it("the bar the drop arranged is the one the pane paints again", () => {
    const compose = doc("docker-compose.yml", 0);
    useProjects.setState({
      groups: [group({})],
      terminals: [term("t1", 0, 0)],
    });
    useEditor.setState({ docs: [compose], activeId: null });

    moveTab("terminal", "t1", "g1", 0, null);

    expect(useProjects.getState().layoutOf("g1").tabOrder).toEqual({
      0: [compose.id, "t1"],
    });
  });

  it("a tab that leaves a pane leaves its saved bar too", () => {
    const compose = doc("docker-compose.yml", 0);
    useProjects.setState({
      groups: [group({})],
      terminals: [term("t1", 0, 0)],
    });
    useEditor.setState({ docs: [compose], activeId: null });
    moveTab("terminal", "t1", "g1", 0, compose.id);

    moveTab("terminal", "t1", "g1", 1, null);

    const { tabOrder } = useProjects.getState().layoutOf("g1");
    expect(tabOrder?.[0]).toEqual([compose.id]);
    expect(tabOrder?.[1]).toEqual(["t1"]);
  });

  it("one step to the right trades places with a file, not with the next CLI", () => {
    const compose = doc("docker-compose.yml", 0);
    useProjects.setState({
      groups: [group({})],
      terminals: [term("t1", 0, 0), term("t2", 0, 1)],
    });
    useEditor.setState({ docs: [compose], activeId: null });
    // Bar as painted: t1, t2, compose. One step right puts t1 after t2.
    moveTabBy("terminal", "t1", "g1", 0, 1);

    expect(paneTabs("g1", 0).map((t) => t.id)).toEqual(["t2", "t1", compose.id]);

    // And again: now the neighbour is the file, and the CLI goes past it.
    moveTabBy("terminal", "t1", "g1", 0, 1);

    expect(paneTabs("g1", 0).map((t) => t.id)).toEqual(["t2", compose.id, "t1"]);
  });

  it("a step into a wall moves nothing", () => {
    useProjects.setState({
      groups: [group({})],
      terminals: [term("t1", 0, 0), term("t2", 0, 1)],
    });

    moveTabBy("terminal", "t1", "g1", 0, -1);

    expect(paneTabs("g1", 0).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(useProjects.getState().layoutOf("g1").tabOrder).toBeUndefined();
  });

  it("a browser changes pane and lands before the target", () => {
    const tab = (id: string, slot: number) => ({
      id,
      groupId: "g1",
      slot,
      url: "about:blank",
    });
    useProjects.setState({ groups: [group({})] });
    useBrowsers.setState({ tabs: [tab("b1", 0), tab("b2", 1)] });

    moveTab("browser", "b1", "g1", 1, "b2");

    const tabs = useBrowsers.getState().tabs;
    expect(tabs.map((t) => t.id)).toEqual(["b1", "b2"]);
    expect(tabs[0].slot).toBe(1);
    expect(useProjects.getState().layoutOf("g1").activeBySlot[1]).toBe("b1");
  });
});
