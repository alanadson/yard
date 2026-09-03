/**
 * The layout switch, the door into the canvas and the project panels all
 * read the same question: is the group on screen a board?
 *
 * The canvas is the boards and nothing else. A project's group is never
 * showing it, so the switch reads that group directly; a board has no panes
 * of its own, but the switch must not disappear from under the user's feet
 * while it is selected: the group they came from still owns
 * Auto/Grade/Holofote, and it is that group the canvas row flips back to.
 */
import { describe, expect, it } from "vitest";

import {
  canvasDoor,
  layoutControlsState,
  paneSwitchVisible,
  projectPanelsShown,
} from "./layoutControls";

const groups = [
  { id: "principal", projectId: "yard" },
  { id: "outro", projectId: "yard" },
  { id: "quadro", projectId: null },
];

describe("layoutControlsState", () => {
  it("a project's group is what the switch reads, with its panes in front", () => {
    expect(
      layoutControlsState({
        activeGroupId: "principal",
        activeProjectId: "yard",
        groupBeforeBoard: null,
        groups,
      }),
    ).toEqual({ groupId: "principal", canvasActive: false });
  });

  /**
   * The regression that motivated the fix: selecting a board replaced the
   * entire Auto/Grade/Holofote switch with a lone “Painéis” button.
   */
  it("selecting a board keeps the layout switch reading a real group, with the canvas in front", () => {
    expect(
      layoutControlsState({
        activeGroupId: "quadro",
        activeProjectId: "yard",
        groupBeforeBoard: "outro",
        groups,
      }),
    ).toEqual({ groupId: "outro", canvasActive: true });
  });

  /**
   * A board's `projectId` is `null`, and so is `activeProjectId` while no
   * project is open: the fallback matched the board against itself and handed
   * back the very group the user is standing on. The switch would then read a
   * board's layout as if it were a project's, and the canvas row's way back
   * would flip the board to the panes instead of leaving it.
   */
  it("a board is never its own way back, not even with no project open", () => {
    expect(
      layoutControlsState({
        activeGroupId: "quadro",
        activeProjectId: null,
        groupBeforeBoard: null,
        groups: [{ id: "quadro", projectId: null }],
      }),
    ).toBeNull();
  });
});

describe("paneSwitchVisible", () => {
  /**
   * The pane switch describes the panes, and a board has none. Left on
   * screen behind the board it was a control for something nobody could
   * see; the way in and out of the canvas is the sidebar's row, so the
   * switch simply leaves while the board is up.
   */
  it("the pane switch leaves the bar while a board is in front", () => {
    expect(paneSwitchVisible({ groupId: "principal", canvasActive: true })).toBe(false);
  });

  it("the pane switch is there whenever the panes are what is on screen", () => {
    expect(paneSwitchVisible({ groupId: "principal", canvasActive: false })).toBe(true);
  });

  it("with no group to read there is no switch to paint", () => {
    expect(paneSwitchVisible(null)).toBe(false);
  });
});

describe("canvasDoor", () => {
  const boards = [{ id: "quadro" }];
  type DoorInput = Parameters<typeof canvasDoor>[0];
  const door = (activeGroupId: string | null, extra: Partial<DoorInput> = {}) =>
    canvasDoor({
      activeGroupId,
      activeProjectId: "yard",
      groupBeforeBoard: null,
      groups,
      boards,
      lastBoard: null,
      canvasSide: activeGroupId === "quadro",
      ...extra,
    });

  /**
   * The contract that changed: the door used to open the active group's own
   * canvas. A project's group has no canvas any more, so from the panes the
   * door leads to a board, the only place the canvas exists.
   */
  it("with the panes on screen the door leads to a board, never to the group's own canvas", () => {
    expect(door("principal")).toEqual({ open: false, group: "quadro" });
  });

  it("it goes back to the board visited last this session", () => {
    const two = [{ id: "um" }, { id: "dois" }];
    expect(door("principal", { boards: two, lastBoard: "dois" })).toEqual({
      open: false,
      group: "dois",
    });
  });

  it("a last board that has since been deleted falls back to the first", () => {
    const two = [{ id: "um" }, { id: "dois" }];
    expect(door("principal", { boards: two, lastBoard: "sumiu" })).toEqual({
      open: false,
      group: "um",
    });
  });

  it("on a board the door is pressed and points back at the group the user came from", () => {
    expect(door("quadro", { groupBeforeBoard: "outro" })).toEqual({
      open: true,
      group: "outro",
    });
  });

  /**
   * The regression that motivated the fix: with every group closed the door
   * was not painted at all, and the canvas, with the boards inside it, which
   * belong to no project, had no way in.
   */
  it("with no group open the door still leads to a board", () => {
    expect(door(null)).toEqual({ open: false, group: "quadro" });
  });

  it("with no board yet the door has nothing to open, and says so", () => {
    expect(door(null, { groups: [], boards: [] })).toEqual({ open: false, group: null });
  });

  /**
   * The regression that motivated the fix: deleting the last board left no
   * active group, and the door, reading only the group, went back to
   * "closed": the bar swapped the empty boards section for the projects tree
   * while the user was still on the canvas side.
   */
  it("with the last board just deleted the door stays pressed: the user is still on the canvas side", () => {
    expect(door(null, { boards: [], canvasSide: true })).toEqual({ open: true, group: null });
  });

  it("on a board with no group behind it there are no panes to go back to", () => {
    expect(
      door("quadro", {
        activeProjectId: null,
        groups: [{ id: "quadro", projectId: null }],
      }),
    ).toEqual({ open: true, group: null });
  });
});

/**
 * The changes panel and the bench read the active *project*: its working
 * tree, its tasks, its files. A board belongs to no project, so with a board
 * on screen the two doors describe something that is not there. They leave
 * the title bar, and the panels behind them leave with them.
 */
describe("projectPanelsShown", () => {
  it("on the canvas side the project panels are off screen, with or without a board", () => {
    expect(projectPanelsShown({ canvasSide: true })).toBe(false);
  });

  it("on the panes side they are where they always were", () => {
    expect(projectPanelsShown({ canvasSide: false })).toBe(true);
  });
});
