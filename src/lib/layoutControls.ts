/**
 * Which pane group the title bar's layout switch and the sidebar's canvas
 * row are talking about.
 *
 * A standalone board has no panes, but the door into it must not disappear
 * while it is selected: the group the user came from still owns
 * Auto/Grade/Holofote, and that is the group the canvas row flips back to.
 */
import type { Surface } from "./surface";

interface GroupRef {
  id: string;
  projectId: string | null;
}

interface LayoutControlsInput {
  activeGroupId: string | null;
  activeProjectId: string | null;
  groupBeforeBoard: string | null;
  activeSurface: Surface;
  groups: GroupRef[];
}

export interface LayoutControlsState {
  /** The project group whose pane mode the switch reads and writes. */
  groupId: string;
  /** Whether Canvas is the surface currently in front of the user. */
  canvasActive: boolean;
}

export function layoutControlsState({
  activeGroupId,
  activeProjectId,
  groupBeforeBoard,
  activeSurface,
  groups,
}: LayoutControlsInput): LayoutControlsState | null {
  const active = groups.find((group) => group.id === activeGroupId);
  if (!active) return null;

  if (active.projectId !== null) {
    return { groupId: active.id, canvasActive: activeSurface === "canvas" };
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
 * The canvas is the group's *other* surface, so with the board up the switch
 * describes something nobody can see: it used to sit there dimmed, a live
 * control for an absent screen. It leaves instead, and the way in and out of
 * the canvas is the sidebar's row, which is a toggle.
 */
export function paneSwitchVisible(controls: LayoutControlsState | null): boolean {
  return controls !== null && !controls.canvasActive;
}

/**
 * What the sidebar's Canvas row does, in every state the workspace can be in.
 *
 * The row is the app's only door into the canvas since the title bar's button
 * left, so — unlike the pane switch — it is never absent: a door that is only
 * there once you are already inside is not a door. `layoutControlsState`
 * alone could not answer for the two states below, and in both of them the
 * row simply vanished:
 *
 * - **no group open at all** (a fresh workspace, or every tab closed): there
 *   is no group whose other surface the canvas could be, but the boards are
 *   the canvas belonging to no project — so the row goes to one of those, and
 *   with none in the workspace yet it reports `null` and the caller makes one;
 * - **a board with no panes behind it**: the row is pressed, and there is no
 *   group to go back to — the panes' own empty state is where it lands.
 */
export type CanvasDoor = {
  /** Whether the canvas is what is on screen — the row reads pressed. */
  open: boolean;
  /**
   * The group the click acts on: whose canvas to open while closed, whose
   * panes to come back to while open. `null` is the honest answer, never a
   * reason to hide the row.
   */
  group: string | null;
};

interface CanvasDoorInput extends LayoutControlsInput {
  /** The boards, in the order the bar paints them. */
  boards: { id: string }[];
}

export function canvasDoor({ boards, ...input }: CanvasDoorInput): CanvasDoor {
  const controls = layoutControlsState(input);
  if (controls) return { open: controls.canvasActive, group: controls.groupId };

  // No group to read. Either the active one is a board with nothing behind it
  // — the canvas is up, and back is the panes' empty state — or nothing is
  // open at all, and the way into the canvas is a board.
  const active = input.groups.find((group) => group.id === input.activeGroupId);
  if (active) return { open: true, group: null };
  return { open: false, group: boards[0]?.id ?? null };
}
