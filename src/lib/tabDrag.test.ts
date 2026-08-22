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

import { moveTab } from "./tabDrag";
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
