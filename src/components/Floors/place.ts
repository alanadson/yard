/**
 * Where the fronts control is allowed to float — the rule, out of the JSX.
 *
 * A front is a sibling copy of the repository with a canvas of its own, and
 * the canvas is where you move between them. Off the board the button had no
 * surface of its own to sit on: it floated over whatever the panes were
 * drawing, and the bottom-right corner of a pane already belongs to the code
 * editor's footer.
 */

export interface Placement {
  /** The group is showing its canvas, not the pane grid. */
  canvas: boolean;
  /**
   * A board is a group with no project — each of its cards carries its own
   * folder, so there is no worktree for the control to switch.
   */
  board: boolean;
}

/** The one place the button exists: the canvas of a project. */
export function showsFloorsControl(where: Placement): boolean {
  return where.canvas && !where.board;
}
