/**
 * Where the fronts control is allowed to float.
 *
 * The button was born "present in every mode, because switching fronts does
 * not depend on the canvas" — and that reasoning is about the *model*, not
 * about the screen. On the pane grid it landed 16px from the bottom-right
 * corner, which is where the code editor writes its footer: the layers icon
 * sat on top of "Ln 1, Col 1 · LF · Markdown", covering a reading with a
 * control nobody had asked for in that surface. A front is a thing you switch
 * between *boards*, and the board is where the button belongs.
 *
 * The rule is three booleans wide, which is exactly why it left the JSX: a
 * negative ("never outside the canvas") that lives only as a `&&` in the
 * middle of a render is a negative nobody can see, and the next person to add
 * a corner control reads the condition beside it and copies it.
 */
import { describe, expect, it } from "vitest";

import gridSrc from "../WorkspaceGrid/index.tsx?raw";
import { showsFloorsControl } from "./place";

describe("the fronts control", () => {
  it("shows on the canvas of a project — the surface fronts are switched from", () => {
    expect(showsFloorsControl({ canvas: true, board: false })).toBe(true);
  });

  it("never shows outside the canvas: on the pane grid the corner is the editor's footer", () => {
    expect(showsFloorsControl({ canvas: false, board: false })).toBe(false);
  });

  it("stays away from a board, which has no project and so no worktree to switch to", () => {
    expect(showsFloorsControl({ canvas: true, board: true })).toBe(false);
    expect(showsFloorsControl({ canvas: false, board: true })).toBe(false);
  });
});

describe("the grid, which is what paints it", () => {
  it("asks the rule instead of writing the condition again", () => {
    expect(gridSrc).toContain("showsFloorsControl(");
  });

  it("has no second placement left to pass down — the grid corner is gone, not hidden", () => {
    expect(gridSrc).not.toContain("variant");
  });
});
