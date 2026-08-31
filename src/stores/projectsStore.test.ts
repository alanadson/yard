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

import { parseLayout, useProjects } from "./projectsStore";

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

  /**
   * The pin the file tabs already had, now on a CLI: it holds the front of
   * the bar, so `moveTerminalBy` has to refuse the swap that would drop it
   * behind a loose tab: `orderTabs` would put it back on the next render and
   * the user would see the command do nothing, silently.
   */
  it("fixing a CLI keeps it at the front of its own bar", () => {
    const { g, t1, t2, t3 } = build();

    useProjects.getState().toggleTerminalPin(t3);

    expect(useProjects.getState().terminal(t3)?.pinned).toBe(true);
    expect(useProjects.getState().tabsOfPane(g, 0).map((t) => t.id)).toEqual([t3, t1, t2]);
  });

  it("unfixing puts the CLI back where it was in the loose half", () => {
    const { g, t1, t2, t3 } = build();

    useProjects.getState().toggleTerminalPin(t3);
    useProjects.getState().toggleTerminalPin(t3);

    expect(useProjects.getState().terminal(t3)?.pinned).toBe(false);
    expect(useProjects.getState().tabsOfPane(g, 0).map((t) => t.id)).toEqual([t1, t2, t3]);
  });

  it("a pinned CLI does not walk backwards into the loose ones", () => {
    const { g, t1, t2, t3 } = build();
    useProjects.getState().toggleTerminalPin(t1);

    // t1 is alone in the pinned half: right would drop it behind t2.
    useProjects.getState().moveTerminalBy(t1, 1);

    expect(useProjects.getState().tabsOfPane(g, 0).map((t) => t.id)).toEqual([t1, t2, t3]);
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

/**
 * The canvas and the pane grid used to be one field and one pool of
 * terminals. Two things came out of that and both are locked down here: a
 * CLI showed up on **both** surfaces, and choosing Canvas erased the
 * Grade/Holofote the user had pinned — because `mode` was the same field.
 */
describe("surfaces", () => {
  beforeEach(() => {
    saveWorkspace.mockReset();
    loadWorkspace.mockReset();
    readPrefs.mockResolvedValue({ layoutTabsMigrated: "true" });
    useProjects.setState({
      rev: 1,
      loaded: true,
      projects: [],
      groups: [],
      terminals: [],
      activeProjectId: null,
      activeGroupId: null,
      groupBeforeBoard: null,
    });
  });

  const build = () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/sf")!;
    const g = useProjects.getState().addGroup(p, "G");
    const make = (title: string, surface?: "grid" | "canvas") =>
      useProjects.getState().addTerminal({
        groupId: g,
        program: "pwsh",
        cwd: "C:/Workspace/sf",
        title,
        surface,
      });
    return { p, g, make };
  };

  it("a new group opens on the grid, in automatic mode", () => {
    const { g } = build();
    const layout = useProjects.getState().layoutOf(g);
    expect(layout.surface).toBe("grid");
    expect(layout.mode).toBe("auto");
  });

  it("showing the canvas keeps the grid the user had pinned", () => {
    const { g } = build();
    useProjects.getState().updateLayout(g, { mode: "spotlight", panelCount: 3 });

    useProjects.getState().updateLayout(g, { surface: "canvas" });

    const layout = useProjects.getState().layoutOf(g);
    expect(layout.surface).toBe("canvas");
    expect(layout.mode).toBe("spotlight");
    expect(layout.panelCount).toBe(3);
  });

  it("a workspace saved with the old four-valued mode still opens on the canvas", () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/old")!;
    const g = useProjects.getState().addGroup(p, "G");
    useProjects.setState((s) => ({
      groups: s.groups.map((x) =>
        x.id === g
          ? { ...x, layoutJson: JSON.stringify({ mode: "canvas", panelCount: 2 }) }
          : x,
      ),
    }));

    const layout = useProjects.getState().layoutOf(g);
    expect(layout.surface).toBe("canvas");
    expect(layout.mode).toBe("auto");
  });

  it("a CLI is born on the grid unless it is asked for on the canvas", () => {
    const { make } = build();
    const onGrid = make("pane");
    const onBoard = make("card", "canvas");

    expect(useProjects.getState().terminal(onGrid)?.surface).toBe("grid");
    expect(useProjects.getState().terminal(onBoard)?.surface).toBe("canvas");
  });

  /** The whole point: neither surface ever draws the other one's CLIs. */
  it("each surface only lists its own terminals", () => {
    const { g, make } = build();
    const onGrid = make("pane");
    const onBoard = make("card", "canvas");

    expect(useProjects.getState().terminalsOn(g, "grid").map((t) => t.id)).toEqual([
      onGrid,
    ]);
    expect(useProjects.getState().terminalsOn(g, "canvas").map((t) => t.id)).toEqual([
      onBoard,
    ]);
    // `terminalsOf` stays the whole group — closing it has to take both.
    expect(useProjects.getState().terminalsOf(g)).toHaveLength(2);
  });

  it("dropping a tab onto a pane never drags it off the canvas", () => {
    const { g, make } = build();
    const onBoard = make("card", "canvas");

    useProjects.getState().moveTerminal(onBoard, 1);

    expect(useProjects.getState().terminal(onBoard)?.surface).toBe("canvas");
    expect(useProjects.getState().terminalsOn(g, "grid")).toHaveLength(0);
  });

  /**
   * `slot` means "pane" and only the grid has panes, so a card sitting on the
   * default slot 0 used to count as a sibling of the tabs in pane 0 — and the
   * tree's "move up" swapped a tab's place with a card's.
   */
  it("reordering tabs never swaps places with a card", () => {
    const { g, make } = build();
    const first = make("primeira");
    const card = make("cartao", "canvas");
    const second = make("segunda");

    useProjects.getState().moveTerminalBy(second, -1);

    expect(useProjects.getState().terminalsOn(g, "grid").map((t) => t.id)).toEqual([
      second,
      first,
    ]);
    expect(useProjects.getState().terminalsOn(g, "canvas").map((t) => t.id)).toEqual([
      card,
    ]);
  });

  it("closing a tab hands the pane to the next tab, never to a card", () => {
    const { g, make } = build();
    const closing = make("fechando");
    make("cartao", "canvas");
    const next = make("proxima");
    expect(useProjects.getState().layoutOf(g).activeBySlot[0]).toBe(next);
    useProjects.getState().setActiveTab(g, 0, closing);

    useProjects.getState().removeTerminal(closing);

    expect(useProjects.getState().layoutOf(g).activeBySlot[0]).toBe(next);
  });

  /**
   * The migration of everything that predates the split: a terminal with no
   * surface goes to the one its group was showing, so nothing moves on screen
   * the first time the app opens after the change.
   */
  it("on load, terminals with no surface land on the one their group was showing", async () => {
    loadWorkspace.mockResolvedValue({
      rev: 4,
      projects: [
        {
          id: "p1",
          name: "p1",
          path: "C:\p1",
          color: null,
          icon: null,
          sort: 0,
          createdAt: 0,
        },
      ],
      groups: [
        {
          id: "board",
          projectId: "p1",
          name: "board",
          layoutJson: JSON.stringify({ mode: "canvas" }),
          suspended: false,
          sort: 0,
        },
        {
          id: "panes",
          projectId: "p1",
          name: "panes",
          layoutJson: JSON.stringify({ mode: "spotlight" }),
          suspended: false,
          sort: 1,
        },
      ],
      terminals: [
        { id: "old-card", groupId: "board", slot: 0, kind: "shell", program: "pwsh", args: [], cwd: "C:\p1", sort: 0, alive: false, createdAt: 0 },
        // `null` is what the backend sends for a row that predates the
        // column: the migration there adds it empty on purpose, so this side
        // is the only one that decides.
        { id: "old-tab", groupId: "panes", slot: 0, kind: "shell", program: "pwsh", args: [], cwd: "C:\p1", sort: 1, alive: false, createdAt: 0, surface: null },
        { id: "already", groupId: "board", slot: 0, kind: "shell", program: "pwsh", args: [], cwd: "C:\p1", sort: 2, alive: false, createdAt: 0, surface: "grid" },
      ],
    });
    saveWorkspace.mockResolvedValue({ accepted: true, rev: 5 });

    await useProjects.getState().load();

    const surfaceOf = (id: string) => useProjects.getState().terminal(id)?.surface;
    expect(surfaceOf("old-card")).toBe("canvas");
    expect(surfaceOf("old-tab")).toBe("grid");
    // A terminal that already carries a surface is never re-stamped.
    expect(surfaceOf("already")).toBe("grid");
    // The stamp has to reach the disk, or it is redone on every boot.
    expect(saveWorkspace).toHaveBeenCalled();
  });
});

/**
 * A **board** ("quadro") is the canvas as its own container: it belongs to no
 * project, because it holds cards from several at once. Modeled as a group
 * with `projectId === null` — one rule, so there is no second flag that could
 * disagree with it.
 */
describe("boards", () => {
  beforeEach(() => {
    saveWorkspace.mockReset();
    loadWorkspace.mockReset();
    readPrefs.mockResolvedValue({ layoutTabsMigrated: "true" });
    useProjects.setState({
      rev: 1,
      loaded: true,
      projects: [],
      groups: [],
      terminals: [],
      activeProjectId: null,
      activeGroupId: null,
      groupBeforeBoard: null,
    });
  });

  it("a new board belongs to no project and opens on the canvas", () => {
    const b = useProjects.getState().addBoard("Refatoração do PTY");

    const row = useProjects.getState().groups.find((g) => g.id === b);
    expect(row?.projectId).toBeNull();
    expect(row?.name).toBe("Refatoração do PTY");
    expect(useProjects.getState().layoutOf(b).surface).toBe("canvas");
    expect(useProjects.getState().isBoard(b)).toBe(true);
    expect(useProjects.getState().activeGroupId).toBe(b);
  });

  it("a board never shows up among a project's groups", () => {
    // `addProject` already opens the project's first group.
    const p = useProjects.getState().addProject("P", "C:/Workspace/b")!;
    const g = useProjects.getState().groupsOf(p)[0].id;
    const b = useProjects.getState().addBoard("Quadro");

    expect(useProjects.getState().groupsOf(p).map((x) => x.id)).toEqual([g]);
    expect(useProjects.getState().boards().map((x) => x.id)).toEqual([b]);
    expect(useProjects.getState().isBoard(g)).toBe(false);
  });

  /**
   * The regression this prevents: a board has no panes at all, so letting the
   * surface be switched left the user staring at an empty grid with no way
   * back — the button that would bring the canvas back is the one they just
   * used to leave it.
   */
  it("a board cannot be turned to the panes", () => {
    const b = useProjects.getState().addBoard("Quadro");

    useProjects.getState().updateLayout(b, { surface: "grid" });

    expect(useProjects.getState().layoutOf(b).surface).toBe("canvas");
  });

  it("a board has no working root of its own — each card carries its folder", () => {
    const b = useProjects.getState().addBoard("Quadro");

    expect(useProjects.getState().rootOfGroup(b)).toBeNull();
    expect(useProjects.getState().projectOfGroup(b)).toBeUndefined();
  });

  /**
   * Boards outlive projects on purpose: a board mixing three projects must not
   * disappear because one of them was closed. Its cards from that project are
   * another matter — they are terminals, and they go.
   */
  it("closing a project leaves the boards standing", () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/b2")!;
    const b = useProjects.getState().addBoard("Quadro");

    useProjects.getState().removeProject(p);

    expect(useProjects.getState().boards().map((x) => x.id)).toEqual([b]);
  });

  /**
   * The bench, the changes panel and the file tree all follow
   * `activeProjectId`. A board has no project, and blanking it would empty
   * three panels the moment the user looked at a board.
   */
  it("opening a board keeps the project the other panels are pointing at", () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/b3")!;
    const b = useProjects.getState().addBoard("Quadro");
    useProjects.getState().setActiveProject(p);

    useProjects.getState().setActiveGroup(b);

    expect(useProjects.getState().activeGroupId).toBe(b);
    expect(useProjects.getState().activeProjectId).toBe(p);
  });

  /**
   * The one-way trip out of the old model. Every board anyone drew before
   * boards existed is inside a group's `layoutJson.canvas`, and on the first
   * load after the change each of those comes out as a board of its own — with
   * the screen still pointing at it.
   */
  it("on load, a canvas drawn inside a group comes out as a board and the screen follows", async () => {
    const drawn = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: { "old-card": { x: 10, y: 20, w: 640, h: 380 } },
      items: [],
    };
    loadWorkspace.mockResolvedValue({
      rev: 6,
      projects: [
        {
          id: "p1",
          name: "yard",
          path: "C:\yard",
          color: null,
          icon: null,
          sort: 0,
          createdAt: 0,
        },
      ],
      groups: [
        {
          id: "g1",
          projectId: "p1",
          name: "Grupo 1",
          layoutJson: JSON.stringify({ mode: "canvas", panelCount: 3, canvas: drawn }),
          suspended: false,
          sort: 0,
        },
      ],
      terminals: [
        { id: "old-card", groupId: "g1", slot: 0, kind: "shell", program: "pwsh", args: [], cwd: "C:\yard", sort: 0, alive: false, createdAt: 0 },
        { id: "old-tab", groupId: "g1", slot: 0, kind: "shell", program: "pwsh", args: [], cwd: "C:\yard", sort: 1, alive: false, createdAt: 0, surface: "grid" },
      ],
    });
    saveWorkspace.mockResolvedValue({ accepted: true, rev: 7 });
    useProjects.setState({ activeProjectId: "p1", activeGroupId: "g1" });

    await useProjects.getState().load();

    const s = useProjects.getState();
    const board = s.boards()[0];
    expect(board?.name).toBe("yard · Grupo 1");
    // The card travelled; the tab stayed in the group.
    expect(s.terminalsOn(board.id, "canvas").map((t) => t.id)).toEqual(["old-card"]);
    expect(s.terminalsOn("g1", "grid").map((t) => t.id)).toEqual(["old-tab"]);
    // The group is back on its panes, with the grid it had pinned.
    expect(s.layoutOf("g1").surface).toBe("grid");
    expect(s.layoutOf("g1").panelCount).toBe(3);
    expect(s.layoutOf("g1").canvas).toBeUndefined();
    // And the user reopens on the board they were looking at, not behind it.
    expect(s.activeGroupId).toBe(board.id);
    expect(saveWorkspace).toHaveBeenCalled();
  });

  /**
   * Leaving a board has to land where the user came from. On the canvas the
   * bar shows only the boards — there is no projects tree to click — and a
   * board has no pane switch either, so without this the way back was the
   * command palette and nothing else.
   */
  it("a board remembers the group you came from, and gives it back", () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/b4")!;
    const first = useProjects.getState().groupsOf(p)[0].id;
    const second = useProjects.getState().addGroup(p, "Grupo 2");
    const b = useProjects.getState().addBoard("Quadro");

    useProjects.getState().setActiveGroup(second);
    useProjects.getState().setActiveGroup(b);
    expect(useProjects.getState().groupBeforeBoard).toBe(second);

    useProjects.getState().leaveBoard();

    expect(useProjects.getState().activeGroupId).toBe(second);
    expect(first).not.toBe(second);
  });

  it("board to board does not lose the group behind them", () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/b5")!;
    const g = useProjects.getState().groupsOf(p)[0].id;
    const b1 = useProjects.getState().addBoard("Um");
    const b2 = useProjects.getState().addBoard("Dois");

    useProjects.getState().setActiveGroup(g);
    useProjects.getState().setActiveGroup(b1);
    useProjects.getState().setActiveGroup(b2);

    expect(useProjects.getState().groupBeforeBoard).toBe(g);
  });

  it("with nowhere to go back to, leaving a board falls to the project's first group", () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/b6")!;
    const g = useProjects.getState().groupsOf(p)[0].id;
    // Straight onto a board, never having been in a group this session.
    const b = useProjects.getState().addBoard("Quadro");
    useProjects.setState({ activeGroupId: b, activeProjectId: p });

    useProjects.getState().leaveBoard();

    expect(useProjects.getState().activeGroupId).toBe(g);
  });

  /**
   * This used to assert that nothing moved, on the grounds that the button
   * calling it was not offered with no group to go back to. The canvas row is
   * a permanent door in the sidebar now (`lib/layoutControls.ts`), offered in
   * every state, so a no-op here is a dead click: leaving lands on the panes'
   * own empty state, "escolha um grupo para começar", which is exactly the
   * screen a workspace with no group has.
   */
  it("with no project at all, leaving a board lands on the panes' empty state", () => {
    useProjects.getState().addBoard("Quadro");

    useProjects.getState().leaveBoard();

    expect(useProjects.getState().activeGroupId).toBeNull();
    expect(useProjects.getState().groupBeforeBoard).toBeNull();
  });

  it("a card on a board keeps the folder it was given, whatever project it came from", () => {
    const b = useProjects.getState().addBoard("Quadro");
    const fromYard = useProjects.getState().addTerminal({
      groupId: b,
      program: "pwsh",
      cwd: "C:/Workspace/Code/yard",
      surface: "canvas",
    });
    const fromOther = useProjects.getState().addTerminal({
      groupId: b,
      program: "pwsh",
      cwd: "C:/Workspace/Code/interagia",
      surface: "canvas",
    });

    expect(useProjects.getState().terminal(fromYard)?.cwd).toBe("C:/Workspace/Code/yard");
    expect(useProjects.getState().terminal(fromOther)?.cwd).toBe(
      "C:/Workspace/Code/interagia",
    );
    expect(useProjects.getState().terminalsOn(b, "canvas")).toHaveLength(2);
  });
});

/**
 * The bar the user arranged by hand. It cannot live in any of the three tab
 * stores — it interleaves all of them — so it rides with the group's layout,
 * and what these lock down is that it survives the round trip through the
 * JSON column and that a corrupt one never brings the group down with it.
 */
describe("tabOrder", () => {
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

  const group = () => {
    const p = useProjects.getState().addProject("P", "C:/Workspace/ord")!;
    return useProjects.getState().addGroup(p, "G");
  };

  it("keeps one bar per pane", () => {
    const g = group();

    useProjects.getState().setTabOrder(g, 0, ["compose", "cli"]);
    useProjects.getState().setTabOrder(g, 1, ["page"]);

    expect(useProjects.getState().layoutOf(g).tabOrder).toEqual({
      0: ["compose", "cli"],
      1: ["page"],
    });
  });

  it("survives the trip through the layout JSON", () => {
    const g = group();
    useProjects.getState().setTabOrder(g, 0, ["compose", "cli"]);

    const json = useProjects.getState().groups.find((x) => x.id === g)!.layoutJson;

    expect(parseLayout(json).tabOrder).toEqual({ 0: ["compose", "cli"] });
  });

  it("a group that never rearranged its bar writes no field at all", () => {
    // Same rule as `canvas`: what was never used does not weigh on the JSON
    // of every group in the workspace.
    const g = group();

    const json = useProjects.getState().groups.find((x) => x.id === g)!.layoutJson;

    expect(parseLayout(json).tabOrder).toBeUndefined();
    expect(json).not.toContain("tabOrder");
  });

  it("throws away a saved order that is not a list of ids", () => {
    expect(
      parseLayout(JSON.stringify({ tabOrder: { 0: "cli", 1: [1, "page"] } })).tabOrder,
    ).toEqual({ 1: ["page"] });
  });
});
