/**
 * The layout switch and the door into the canvas read the same group.
 *
 * A standalone board has no panes of its own, but the switch must not
 * disappear from under the user's feet while it is selected: the group they
 * came from still owns Auto/Grade/Holofote, and it is that group the canvas
 * row flips back to.
 */
import { describe, expect, it } from "vitest";

import { canvasDoor, layoutControlsState, paneSwitchVisible } from "./layoutControls";

const groups = [
  { id: "principal", projectId: "yard" },
  { id: "outro", projectId: "yard" },
  { id: "quadro", projectId: null },
];

describe("layoutControlsState", () => {
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
        activeSurface: "canvas",
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
        activeSurface: "canvas",
        groups: [{ id: "quadro", projectId: null }],
      }),
    ).toBeNull();
  });
});

describe("paneSwitchVisible", () => {
  /**
   * The canvas is a surface of its own, and the pane switch describes the
   * *other* one. Left on screen behind the board it was a control for
   * something nobody could see; the way in and out of the canvas is the
   * sidebar's row now, so the switch simply leaves while the board is up.
   */
  it("the pane switch leaves the bar while the canvas is in front", () => {
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

  it("with the panes on screen the door opens the group's canvas", () => {
    expect(
      canvasDoor({
        activeGroupId: "principal",
        activeProjectId: "yard",
        groupBeforeBoard: null,
        activeSurface: "grid",
        groups,
        boards,
      }),
    ).toEqual({ open: false, group: "principal" });
  });

  it("with the canvas on screen the door is pressed and points back at the panes", () => {
    expect(
      canvasDoor({
        activeGroupId: "principal",
        activeProjectId: "yard",
        groupBeforeBoard: null,
        activeSurface: "canvas",
        groups,
        boards,
      }),
    ).toEqual({ open: true, group: "principal" });
  });

  it("on a board the door points back at the group the user came from", () => {
    expect(
      canvasDoor({
        activeGroupId: "quadro",
        activeProjectId: "yard",
        groupBeforeBoard: "outro",
        activeSurface: "canvas",
        groups,
        boards,
      }),
    ).toEqual({ open: true, group: "outro" });
  });

  /**
   * The regression that motivated the fix: with every group closed the door
   * was not painted at all, and the canvas — with the boards inside it, which
   * belong to no project — had no way in. The bar showed Busca and Anotações
   * and nothing else, and the palette's row is gated on a group too.
   */
  it("with no group open the door still leads to the canvas, through a board", () => {
    expect(
      canvasDoor({
        activeGroupId: null,
        activeProjectId: "yard",
        groupBeforeBoard: null,
        activeSurface: "grid",
        groups,
        boards,
      }),
    ).toEqual({ open: false, group: "quadro" });
  });

  it("with no group and no board the door has nothing to open yet, and says so", () => {
    expect(
      canvasDoor({
        activeGroupId: null,
        activeProjectId: "yard",
        groupBeforeBoard: null,
        activeSurface: "grid",
        groups: [],
        boards: [],
      }),
    ).toEqual({ open: false, group: null });
  });

  it("on a board with no group behind it there are no panes to go back to", () => {
    expect(
      canvasDoor({
        activeGroupId: "quadro",
        activeProjectId: null,
        groupBeforeBoard: null,
        activeSurface: "canvas",
        groups: [{ id: "quadro", projectId: null }],
        boards,
      }),
    ).toEqual({ open: true, group: null });
  });
});
