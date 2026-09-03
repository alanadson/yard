/**
 * The one way to write on a group's canvas from **outside the canvas view**.
 *
 * It lived inside `bridge.ts`, which was fine while agents were the only
 * non-user writer. They are not: routines write here, and so does closing a
 * terminal (which has to take the card, its role and its wires with it).
 * `lifecycle.ts` cannot import from `bridge.ts` — the bridge already imports
 * `closeTerminal` from it — so the function moved to its own module instead of
 * being duplicated at the second call site.
 */
import {
  CANVAS_EXTERNAL_WRITE,
  EMPTY_CANVAS,
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  type CanvasData,
} from "./canvas";
import { placedCorners } from "./canvasOps";
import { cameraFor, dropAt, unstack, type DropPoint } from "./dropPoint";
import {
  boardBoxes,
  PLACEMENT_HINTS_EVENT,
  placementCandidates,
  type PlacementHints,
} from "./placement";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

/**
 * Applies a canvas change that did not come from the user and notifies the
 * UI. The notice exists because of undo: `CanvasView` keeps whole-canvas
 * snapshots, so without it the user's `Ctrl+Z` would restore a snapshot taken
 * before the agent wrote — erasing work nobody asked to erase.
 */
export function commitCanvasExternal(
  groupId: string,
  fn: (c: CanvasData) => CanvasData,
) {
  useProjects.getState().updateCanvas(groupId, fn);
  window.dispatchEvent(new CustomEvent(CANVAS_EXTERNAL_WRITE, { detail: { groupId } }));
}

/**
 * Pins a card the user just created where the user was pointing.
 *
 * A terminal with no entry in `nodes` gets an automatic slot in a 3-column
 * grid — the right answer for a board being filled in order, and the wrong
 * one for every terminal opened *at* a chosen empty space. `at` carries the
 * point when the gesture had one (a right-click on the canvas); without it
 * the canvas is asked where the mouse is. Nobody to ask — the group is
 * showing panes, or it is not the one on screen — and the grid keeps the job.
 *
 * With a camera and no explicit point, the spot comes from the guided
 * placement (`lib/placement.ts`): the nearest empty pocket one gap away from
 * whatever is already there, with the runners-up handed to the canvas so a
 * keystroke can move the card to any of them. The cascade `unstack` is the
 * fallback for a board where nothing fits.
 *
 * This used to be a plain `updateCanvas`, on the reasoning that the user is
 * creating something and blanking their undo history over it would be a
 * strange price. The price of *not* doing it turned out to be worse: undo
 * keeps whole-canvas snapshots, so a write that pushes none leaves the stack
 * holding a canvas from before this card existed — and the next `Ctrl+Z`,
 * aimed at some earlier stroke, deleted a card the user had just made,
 * together with the role and the tint the dialog had put on it.
 *
 * Losing the history is the lesser evil and it is visible (the undo arrow
 * goes blank), which is the same trade the agent-write path already makes.
 */
export function placeCard(
  groupId: string,
  terminalId: string,
  at?: DropPoint | null,
) {
  const size = { w: NODE_DEFAULT_W, h: NODE_DEFAULT_H };
  if (at) {
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      nodes: { ...c.nodes, [terminalId]: { ...unstack(at, placedCorners(c)), ...size } },
    }));
    return;
  }
  const cam = cameraFor(groupId);
  if (!cam) return;
  const current = useProjects.getState().layoutOf(groupId).canvas ?? EMPTY_CANVAS;
  const anchor = cam.cursor ?? {
    x: cam.view.x + cam.view.w / 2,
    y: cam.view.y + cam.view.h / 2,
  };
  const spots = placementCandidates({
    area: cam.view,
    obstacles: boardBoxes(current),
    size,
    anchor,
  });
  const spot = spots[0] ?? unstack(dropAt(cam, size), placedCorners(current));
  commitCanvasExternal(groupId, (c) => ({
    ...c,
    nodes: { ...c.nodes, [terminalId]: { x: spot.x, y: spot.y, ...size } },
  }));
  if (spots.length > 1 && useUI.getState().prefs.placementHints) {
    const detail: PlacementHints = { groupId, id: terminalId, spots };
    window.dispatchEvent(new CustomEvent(PLACEMENT_HINTS_EVENT, { detail }));
  }
}
