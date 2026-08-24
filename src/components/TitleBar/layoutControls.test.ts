/**
 * The layout switch must stay a stable way into and out of Canvas even when
 * the active canvas is a standalone board with no pane layout of its own.
 */
import { describe, expect, it } from "vitest";

import { layoutControlsState } from "./layoutControls";

const groups = [
  { id: "principal", projectId: "yard" },
  { id: "outro", projectId: "yard" },
  { id: "quadro", projectId: null },
];

describe("layoutControlsState", () => {
  /**
   * The regression that motivated the fix: selecting a board replaced the
   * entire Auto/Grade/Holofote/Canvas switch with a lone “Painéis” button.
   */
  it("selecting a board keeps the full layout switch, with Canvas active", () => {
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
});
