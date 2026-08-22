import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveWorkspace, loadWorkspace, readPrefs } = vi.hoisted(() => ({
  saveWorkspace: vi.fn(),
  loadWorkspace: vi.fn(),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    saveWorkspace,
    loadWorkspace,
    readPrefs,
    writePref: vi.fn(async () => undefined),
  },
}));

import { useProjects } from "./projectsStore";

describe("projectsStore persistence", () => {
  beforeEach(() => {
    saveWorkspace.mockReset();
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

  it("serialises concurrent saves and persists the newest snapshot", async () => {
    let finishFirst!: (value: { accepted: boolean; rev: number }) => void;
    saveWorkspace
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ accepted: true, rev: 3 });

    const first = useProjects.getState().save();
    useProjects.setState({
      groups: [
        {
          id: "g1",
          projectId: "p1",
          name: "novo",
          layoutJson: "{}",
          suspended: false,
          sort: 0,
        },
      ],
    });
    const second = useProjects.getState().save();

    expect(second).toBe(first);
    finishFirst({ accepted: true, rev: 2 });
    await second;

    expect(saveWorkspace).toHaveBeenCalledTimes(2);
    expect(saveWorkspace.mock.calls[1][0]).toMatchObject({
      rev: 2,
      groups: [{ id: "g1", name: "novo" }],
    });
    expect(useProjects.getState().rev).toBe(3);
  });
});

/**
 * `load` is not only the boot path: it is also the recovery from a `save`
 * refused for a stale revision. There it re-pointed the selection to the
 * workspace's first project, and whoever was working on the third got
 * teleported somewhere else — with the grid remounting along with it.
 */
describe("projectsStore load", () => {
  const theProject = (id: string) => ({
    id,
    name: id,
    path: `C:\\${id}`,
    color: null,
    icon: null,
    sort: 0,
    createdAt: 0,
  });
  const theGroup = (id: string, projectId: string) => ({
    id,
    projectId,
    name: id,
    layoutJson: "{}",
    suspended: false,
    sort: 0,
  });

  beforeEach(() => {
    saveWorkspace.mockReset();
    loadWorkspace.mockReset();
    // The tab migration already ran on this profile: out of the test's way.
    readPrefs.mockResolvedValue({ layoutTabsMigrated: "true" });
  });

  it("preserves the active project and group when they still exist", async () => {
    loadWorkspace.mockResolvedValue({
      rev: 7,
      projects: [theProject("p1"), theProject("p2")],
      groups: [theGroup("g1", "p1"), theGroup("g2", "p2")],
      terminals: [],
    });
    useProjects.setState({ activeProjectId: "p2", activeGroupId: "g2" });

    await useProjects.getState().load();

    expect(useProjects.getState().activeProjectId).toBe("p2");
    expect(useProjects.getState().activeGroupId).toBe("g2");
  });

  it("falls back to the first project when the active one left the workspace", async () => {
    loadWorkspace.mockResolvedValue({
      rev: 8,
      projects: [theProject("p1")],
      groups: [theGroup("g1", "p1")],
      terminals: [],
    });
    useProjects.setState({ activeProjectId: "sumiu", activeGroupId: "tambem" });

    await useProjects.getState().load();

    expect(useProjects.getState().activeProjectId).toBe("p1");
    expect(useProjects.getState().activeGroupId).toBe("g1");
  });

  it("at boot, with no earlier selection, opens on the first project", async () => {
    loadWorkspace.mockResolvedValue({
      rev: 1,
      projects: [theProject("p1"), theProject("p2")],
      groups: [theGroup("g1", "p1"), theGroup("g2", "p2")],
      terminals: [],
    });
    useProjects.setState({ activeProjectId: null, activeGroupId: null });

    await useProjects.getState().load();

    expect(useProjects.getState().activeProjectId).toBe("p1");
    expect(useProjects.getState().activeGroupId).toBe("g1");
  });

  it("an orphan group does not drag the selection to the wrong project", async () => {
    // The active group survived, the active project did not: the group wins.
    loadWorkspace.mockResolvedValue({
      rev: 9,
      projects: [theProject("p1"), theProject("p2")],
      groups: [theGroup("g1", "p1"), theGroup("g2", "p2")],
      terminals: [],
    });
    useProjects.setState({ activeProjectId: "sumiu", activeGroupId: "g2" });

    await useProjects.getState().load();

    expect(useProjects.getState().activeProjectId).toBe("p2");
    expect(useProjects.getState().activeGroupId).toBe("g2");
  });
});

describe("projectsStore structure", () => {
  beforeEach(() => {
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

  /**
   * The check lived only in the dialog, so any other route created two
   * projects over the same folder — each with its own watcher on the same disk.
   */
  it("refuses a folder that is already in the workspace", () => {
    const id = useProjects.getState().addProject("Um", "C:/Workspace/proj");
    expect(id).not.toBeNull();
    // The same folder spelled another way is still the same folder.
    expect(useProjects.getState().addProject("Outro", "c:/workspace/proj/")).toBeNull();
    expect(useProjects.getState().projects).toHaveLength(1);
  });

  /**
   * `sort` was the sibling count: deleting the middle one left 0 and 2, and
   * the next was born on 2 as well — a tie only the array order broke.
   */
  it("the next group is born after the last one, even after removals", () => {
    const s = useProjects.getState();
    const p = s.addProject("P", "C:/Workspace/p")!;
    const a = useProjects.getState().addGroup(p, "A");
    const b = useProjects.getState().addGroup(p, "B");
    useProjects.getState().removeGroup(a);
    const c = useProjects.getState().addGroup(p, "C");

    const sorts = useProjects.getState().groupsOf(p).map((g) => g.sort);
    expect(new Set(sorts).size).toBe(sorts.length);
    const order = useProjects.getState().groupsOf(p).map((g) => g.id);
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(c));
  });

  it("the next tab is born after the last one, even after removals", () => {
    const s = useProjects.getState();
    const p = s.addProject("P", "C:/Workspace/p2")!;
    const g = useProjects.getState().addGroup(p, "G");
    const create = (title: string) =>
      useProjects.getState().addTerminal({
        groupId: g,
        program: "pwsh",
        cwd: "C:/Workspace/p2",
        title,
      });
    const t1 = create("um");
    const t2 = create("dois");
    useProjects.getState().removeTerminal(t1);
    const t3 = create("tres");

    const tabs = useProjects.getState().terminalsOf(g);
    const sorts = tabs.map((t) => t.sort);
    expect(new Set(sorts).size).toBe(sorts.length);
    expect(tabs.map((t) => t.id)).toEqual([t2, t3]);
  });
});

describe("moveTerminal", () => {
  beforeEach(() => {
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

  const build = () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/mv")!;
    const g = useProjects.getState().addGroup(p, "G");
    const make = (title: string) =>
      useProjects.getState().addTerminal({
        groupId: g,
        program: "pwsh",
        cwd: "C:/Workspace/mv",
        title,
      });
    return { g, t1: make("um"), t2: make("dois"), t3: make("tres") };
  };

  it("drops the tab before another one in the same bar", () => {
    const { g, t1, t2, t3 } = build();

    useProjects.getState().moveTerminal(t3, 0, t1);

    const tabs = useProjects.getState().terminalsOf(g);
    expect(tabs.map((t) => t.id)).toEqual([t3, t1, t2]);
    // A `sort` tie would leave the order to the array position, which a
    // save/load does not promise to keep.
    expect(new Set(tabs.map((t) => t.sort)).size).toBe(3);
  });

  it("with no target, lands at the end of the destination pane's section", () => {
    const { g, t1, t2, t3 } = build();

    useProjects.getState().moveTerminal(t1, 1);
    useProjects.getState().moveTerminal(t2, 1);

    const tabs = useProjects.getState().terminalsOf(g);
    expect(tabs.find((t) => t.id === t1)?.slot).toBe(1);
    expect(tabs.find((t) => t.id === t2)?.slot).toBe(1);
    const ofPane = tabs.filter((t) => t.slot === 1).map((t) => t.id);
    expect(ofPane).toEqual([t1, t2]);
    // The dropped tab becomes the active one of the pane that received it.
    expect(useProjects.getState().layoutOf(g).activeBySlot[1]).toBe(t2);
    expect(tabs.find((t) => t.id === t3)?.slot).toBe(0);
  });

  it("moves the tab one place up among the siblings of the same pane", () => {
    const { g, t1, t2, t3 } = build();

    useProjects.getState().moveTerminalBy(t3, -1);

    expect(useProjects.getState().terminalsOf(g).map((t) => t.id)).toEqual([
      t1,
      t3,
      t2,
    ]);
  });

  it("does not move past the ends nor between different panes", () => {
    const { g, t1, t2, t3 } = build();
    useProjects.getState().moveTerminal(t2, 1);

    // t1 is the first in pane 0: there is nowhere to go up.
    useProjects.getState().moveTerminalBy(t1, -1);
    // t3 only has t1 as a sibling in pane 0 — t2 changed panes and does not count.
    useProjects.getState().moveTerminalBy(t3, 1);

    const tabs = useProjects.getState().terminalsOf(g);
    expect(tabs.filter((t) => t.slot === 0).map((t) => t.id)).toEqual([t1, t3]);
    expect(tabs.find((t) => t.id === t2)?.slot).toBe(1);
  });

  it("dropping the tab onto itself changes nothing", () => {
    const { g, t1, t2, t3 } = build();

    useProjects.getState().moveTerminal(t2, 0, t2);

    expect(useProjects.getState().terminalsOf(g).map((t) => t.id)).toEqual([
      t1,
      t2,
      t3,
    ]);
  });
});
