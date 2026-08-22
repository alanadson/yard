/**
 * "Take the screen to this thing."
 *
 * There was one copy of this inside Search and another, incomplete, in the
 * project tree — and the incomplete one served the app's most frequent
 * gesture: clicking a CLI in the sidebar switched the group and the focus,
 * but not the visible tab, so the screen did not change. With the group in
 * canvas mode the hole was a different one: the card got keyboard focus
 * without the camera going to it, and the user typed into a window out of
 * view.
 *
 * Both routes live here, once:
 *
 * - **grid**: the pane's tab becomes the active one and the terminal gets
 *   focus;
 * - **canvas**: `revealOnCanvas` selects and centres the card (`CanvasView`
 *   responds in an effect, because the target group's canvas may not even be
 *   mounted when the choice happens).
 */
import { useProjects, type LayoutMode } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";
import type { TerminalRow } from "./ipc";

/** Takes the screen to a terminal — in any layout mode. */
export function goToTerminal(term: TerminalRow) {
  const projects = useProjects.getState();
  projects.setActiveGroup(term.groupId);
  if (projects.layoutOf(term.groupId).mode === "canvas") {
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
 * Takes the group to the canvas and points at the item.
 *
 * Switching the mode is not a liberty: a note (or a freshly created portal)
 * only exists there, and landing on a grid of terminals with "found it!" and
 * nothing on screen is worse than not finding it.
 */
export function goToCanvasItem(groupId: string, itemId: string) {
  const projects = useProjects.getState();
  projects.setActiveGroup(groupId);
  if (projects.layoutOf(groupId).mode !== "canvas") {
    projects.updateLayout(groupId, { mode: "canvas" as LayoutMode });
  }
  useUI.getState().revealOnCanvas(groupId, itemId);
}
