/**
 * Where the fronts control is allowed to stand.
 *
 * The button was born "present in every mode, because switching fronts does
 * not depend on the canvas", then moved to the corner of a project's canvas,
 * because on the pane grid that corner is where the code editor writes its
 * footer. A project's group has no canvas any more (the canvas is the
 * boards), so the button stands in the status bar, beside the branch chip
 * that reads the same project, and nowhere over the workspace.
 *
 * The rule left the JSX for the same reason as before: a negative ("never on
 * a board") that lives only as a `&&` in the middle of a render is a negative
 * nobody can see, and the next person to add a chip reads the condition
 * beside it and copies it.
 */
import { describe, expect, it } from "vitest";

import gridSrc from "../WorkspaceGrid/index.tsx?raw";
import statusBarSrc from "../StatusBar/index.tsx?raw";
import { showsFloorsControl } from "./place";

describe("the fronts control", () => {
  it("shows under a project's group, whose fronts it switches between", () => {
    expect(showsFloorsControl({ board: false })).toBe(true);
  });

  it("stays away from a board, which has no project and so no worktree to switch to", () => {
    expect(showsFloorsControl({ board: true })).toBe(false);
  });
});

describe("the status bar, which is what paints it", () => {
  it("asks the rule instead of writing the condition again", () => {
    expect(statusBarSrc).toContain("showsFloorsControl(");
    expect(statusBarSrc).toContain("<FloorsControl");
  });

  it("the workspace corner is gone, not hidden: the grid paints no fronts control", () => {
    expect(gridSrc).not.toContain("FloorsControl");
  });
});
