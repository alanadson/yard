/**
 * "Take the screen to this thing."
 *
 * There was one copy of this inside Search and another, incomplete, in the
 * project tree — and the incomplete one served the app's most frequent
 * gesture: clicking a CLI in the sidebar switched the group and the focus,
 * but not the visible tab, so the screen did not change. On a board the hole
 * was a different one: the card got keyboard focus without the camera going
 * to it, and the user typed into a window out of view.
 *
 * Both routes live here, once:
 *
 * - **grid**: the pane's tab becomes the active one and the terminal gets
 *   focus;
 * - **board**: `revealOnCanvas` selects and centres the card (`CanvasView`
 *   responds in an effect, because the target board's canvas may not even be
 *   mounted when the choice happens).
 *
 * Which of the two is the group's own answer: the canvas is the boards
 * (`lib/surface.ts`), so a card lives on a board and a tab in a project's
 * group, and taking the screen there is a change of group, never a flip of
 * some group's surface.
 */
import { canvasDoor } from "./layoutControls";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";
import type { TerminalRow } from "./ipc";

/** Takes the screen to a terminal, on whichever surface it lives. */
export function goToTerminal(term: TerminalRow) {
  const projects = useProjects.getState();
  projects.setActiveGroup(term.groupId);
  if (projects.isBoard(term.groupId)) {
    // Keyboard focus goes along: the card only gets the cursor after
    // `CanvasView` mounts and the focus effect runs.
    useUI.getState().focusTerminal(term.id, term.slot);
    useUI.getState().revealOnCanvas(term.groupId, term.id);
    return;
  }
  projects.setActiveTab(term.groupId, term.slot, term.id);
  useUI.getState().focusTerminal(term.id, term.slot);
}

/** The same, from the id — when the caller only has that in hand. */
export function goToTerminalId(id: string) {
  const term = useProjects.getState().terminal(id);
  if (term) goToTerminal(term);
}

/**
 * Takes the screen to the board and points at the item.
 *
 * A note (or a freshly created portal) only exists on a board, and landing
 * on a grid of terminals with "found it!" and nothing on screen is worse than
 * not finding it.
 */
export function goToCanvasItem(groupId: string, itemId: string) {
  useProjects.getState().setActiveGroup(groupId);
  useUI.getState().revealOnCanvas(groupId, itemId);
}

/**
 * The canvas door, from wherever it is pressed.
 *
 * There are two of them — the sidebar's row and the palette's action — and
 * before this they each carried their own half-copy of the trip, both gated
 * on there being an active group. With every tab closed neither was offered
 * and the canvas, boards and all, had no way in. The decision is
 * `canvasDoor`'s (pure, tested); what is left here is the effect: onto a
 * board (the one visited last, else the first, made here when the workspace
 * has none yet), or off the board and back to the panes.
 */
export function toggleCanvas() {
  const projects = useProjects.getState();
  const door = canvasDoor({
    activeGroupId: projects.activeGroupId,
    activeProjectId: projects.activeProjectId,
    groupBeforeBoard: projects.groupBeforeBoard,
    groups: projects.groups,
    boards: projects.boards(),
    lastBoard: projects.lastBoardId,
    canvasSide: projects.canvasSide,
  });

  if (door.open) {
    // Leaving a board is leaving the group: the board has no panes of its
    // own to come back to, so the trip lands where the user came from.
    projects.leaveBoard();
    return;
  }

  const target = door.group ?? projects.addBoard("");
  if (target !== useProjects.getState().activeGroupId) projects.setActiveGroup(target);
}
