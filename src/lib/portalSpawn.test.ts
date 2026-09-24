/**
 * A portal born beside a terminal takes its place from that terminal's card.
 * When the terminal is a pane, not a card, there is no place to take, and the
 * portal has to land where any new card would, on the canvas, not off it.
 */
import { beforeEach, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  portalOpen: vi.fn(async () => undefined),
  portalRetain: vi.fn(async () => 0),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
}));
vi.mock("./ipc", () => ({ ipc: ipcMock }));
vi.mock("./log", () => ({
  uiLog: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { spawnPortalNear } from "./portalSpawn";
import { useProjects } from "../stores/projectsStore";

beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: () => true });
  useProjects.setState({
    loaded: false,
    projects: [{ id: "p1", name: "proj", path: "C:/proj", color: null, icon: null, sort: 0, createdAt: 0 }],
    groups: [{ id: "g1", projectId: "p1", name: "Ground", layoutJson: JSON.stringify({ surface: "canvas" }), suspended: false, sort: 0 }],
    terminals: [{ id: "t1", groupId: "g1", slot: 0, kind: "agent", program: "claude", args: [], cwd: "C:/proj", sort: 0, alive: true, createdAt: 0, surface: "grid" }],
    activeProjectId: "p1",
    activeGroupId: "g1",
  });
});

/**
 * The regression: the anchor's index among the canvas cards was -1, and the
 * automatic slot for -1 is a negative x, off the board.
 */
it("a portal anchored to a terminal that is not a card lands where a new card would", async () => {
  const id = await spawnPortalNear({ groupId: "g1", url: "http://localhost:3000", nearTerminalId: "t1" });
  const item = useProjects.getState().layoutOf("g1").canvas?.items.find((i) => i.id === id);
  if (item?.type !== "portal") throw new Error("the portal card is not on the canvas");
  expect(item.x).toBeGreaterThanOrEqual(0);
  expect(item.y).toBeGreaterThanOrEqual(0);
});
