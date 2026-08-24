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
 *
 * Both routes start by turning the group to the right surface: the grid and
 * the canvas no longer draw the same terminals, so the screen has to move.
 */
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";
import type { TerminalRow } from "./ipc";
import { normalizeSurface, type Surface } from "./surface";

/**
 * Takes the screen to a terminal — on whichever surface it lives.
 *
 * The surface comes from the **terminal**, not from what the group happens to
 * be showing: since the two stopped sharing their CLIs, a card is nowhere to
 * be seen while the panes are up, and a tab is nowhere to be seen while the
 * board is. So the group is turned to face it first.
 */
export function goToTerminal(term: TerminalRow) {
  const projects = useProjects.getState();
  projects.setActiveGroup(term.groupId);
  const surface = normalizeSurface(term.surface);
  show(term.groupId, surface);
  if (surface === "canvas") {
    // Keyboard focus goes along: the card only gets the cursor after
    // `CanvasView` mounts and the focus effect runs.
    useUI.getState().focusTerminal(term.id, term.slot);
    useUI.getState().revealOnCanvas(term.groupId, term.id);
    return;
  }
  projects.setActiveTab(term.groupId, term.slot, term.id);
  useUI.getState().focusTerminal(term.id, term.slot);
}

/**
 * Turns the group to the given surface, writing nothing if it is already
 * there — the layout is persisted, and a no-op write would schedule a save
 * (and bump the revision) on every click of the project tree.
 *
 * Only `surface` is touched: the pinned Grade/Holofote is the other axis now
 * and has no business changing because someone clicked a card.
 */
export function show(groupId: string, surface: Surface) {
  const projects = useProjects.getState();
  if (projects.layoutOf(groupId).surface === surface) return;
  projects.updateLayout(groupId, { surface });
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
  useProjects.getState().setActiveGroup(groupId);
  show(groupId, "canvas");
  useUI.getState().revealOnCanvas(groupId, itemId);
}
