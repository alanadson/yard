/**
 * Which pane group the title bar's layout switch and the sidebar's canvas
 * row are talking about, and whether the project's panels are on screen.
 *
 * The canvas is the boards and nothing else (`lib/surface.ts`), and it is a
 * **side** of the app the user stands on, `canvasSide` in the store: a board
 * puts them there, a project's group takes them back, and deleting the last
 * board leaves them there with no board to show. A board has no panes of
 * its own, but the door out of it must not disappear while it is selected:
 * the group the user came from still owns Auto/Grade/Holofote, and that is
 * the group the canvas row flips back to.
 */

interface GroupRef {
  id: string;
  projectId: string | null;
}

interface LayoutControlsInput {
  activeGroupId: string | null;
  activeProjectId: string | null;
  groupBeforeBoard: string | null;
  groups: GroupRef[];
}

export interface LayoutControlsState {
  /** The project group whose pane mode the switch reads and writes. */
  groupId: string;
  /** Whether a board (the canvas) is what is in front of the user. */
  canvasActive: boolean;
}

function activeOf(input: { activeGroupId: string | null; groups: GroupRef[] }) {
  return input.groups.find((group) => group.id === input.activeGroupId);
}

export function layoutControlsState({
  activeGroupId,
  activeProjectId,
  groupBeforeBoard,
  groups,
}: LayoutControlsInput): LayoutControlsState | null {
  const active = activeOf({ activeGroupId, groups });
  if (!active) return null;

  if (active.projectId !== null) {
    return { groupId: active.id, canvasActive: false };
  }

  const remembered = groups.find(
    (group) => group.id === groupBeforeBoard && group.projectId !== null,
  );
  // Only a project's group can own the panes. Without the first half of this
  // test a board matched itself whenever no project was open (`null ===
  // null`), and the way back out of the board was the board.
  const fallback = groups.find(
    (group) => group.projectId !== null && group.projectId === activeProjectId,
  );
  const target = remembered ?? fallback;
  return target ? { groupId: target.id, canvasActive: true } : null;
}

/**
 * Whether the title bar paints the pane switch at all.
 *
 * The switch describes the panes, and a board has none: left on screen
 * behind the board it was a live control for an absent screen. It leaves
 * instead, and the way in and out of the canvas is the sidebar's row, which
 * is a toggle.
 */
export function paneSwitchVisible(controls: LayoutControlsState | null): boolean {
  return controls !== null && !controls.canvasActive;
}

/**
 * What the sidebar's Canvas row does, in every state the workspace can be in.
 *
 * The row is the app's only door into the canvas, so, unlike the pane
 * switch, it is never absent: a door that is only there once you are already
 * inside is not a door. Closed, it leads to a board, the only place the
 * canvas exists: the one visited last this session, else the first in the
 * bar, and with none in the workspace yet it reports `null` and the caller
 * makes one. Pressed (the user is on the canvas side, on a board or on the
 * empty space the last board left), it points at the panes to come back to,
 * or `null` when there are none: the panes' own empty state.
 */
export type CanvasDoor = {
  /** Whether the user is on the canvas side: the row reads pressed. */
  open: boolean;
  /**
   * The group the click acts on: the board to open while closed, the panes
   * to come back to while open. `null` is the honest answer, never a reason
   * to hide the row.
   */
  group: string | null;
};

interface CanvasDoorInput extends LayoutControlsInput {
  /** The boards, in the order the bar paints them. */
  boards: { id: string }[];
  /** The board the user stood on last this session, if any. */
  lastBoard: string | null;
  /** Whether the user is on the canvas side (`projectsStore.canvasSide`). */
  canvasSide: boolean;
}

export function canvasDoor({
  boards,
  lastBoard,
  canvasSide,
  ...input
}: CanvasDoorInput): CanvasDoor {
  if (canvasSide) {
    return { open: true, group: layoutControlsState(input)?.groupId ?? null };
  }
  const remembered = boards.find((board) => board.id === lastBoard);
  return { open: false, group: remembered?.id ?? boards[0]?.id ?? null };
}

/**
 * Whether the changes panel and the bench, and the two doors that open them,
 * are on screen.
 *
 * Both read the active *project*: its working tree, its tasks, its files. A
 * board belongs to no project, so on the canvas side, with a board up or on
 * the empty space the last board left, they would describe a project nobody
 * is looking at. They leave with the canvas side and come back with the
 * panes.
 */
export function projectPanelsShown(input: { canvasSide: boolean }): boolean {
  return !input.canvasSide;
}
