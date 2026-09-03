/**
 * Where the fronts control is allowed to stand: the rule, out of the JSX.
 *
 * A front is a project's group, and the control switches between the fronts
 * of the project on screen. It used to float over a project's canvas; a
 * project's group has no canvas any more (the canvas is the boards,
 * `lib/surface.ts`), so the control stands in the status bar, beside the
 * branch chip that reads the same project. A board has no project, hence no
 * fronts, hence no control.
 */

export interface Placement {
  /**
   * A board is a group with no project: each of its cards carries its own
   * folder, so there is no worktree for the control to switch.
   */
  board: boolean;
}

/** The one place the button exists: the status bar, under a project's group. */
export function showsFloorsControl(where: Placement): boolean {
  return !where.board;
}
