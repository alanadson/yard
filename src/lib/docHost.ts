/**
 * Where the tab of an opened file goes.
 *
 * A document is a tab in the **same bar as the CLIs**: the file sits next to
 * the agent editing it, at the same size, and switching between the two is
 * one click in a bar that was already there. The canvas is the exception —
 * it has no tab bar, so there the editor is raised as the big overlay.
 *
 * "No group open" used to be a second exception, and it was the wrong one: a
 * project whose groups were all closed still shows its files in the tree, and
 * clicking one answered with a modal window over the empty workspace. There
 * is nowhere to put the tab only because nobody has opened a pane yet — so
 * one is opened, and the file lands where every other file lands.
 */
import type { Surface } from "./surface";

/** The three answers, in the order the rule tries them. */
export type DocHost =
  /** The active group's tab bar. */
  | "pane"
  /** No group open: one is created for the project, and it holds the tab. */
  | "group"
  /** No tab bar to land in (the canvas), or no project to make one for. */
  | "overlay";

export function docHost(world: {
  groupId: string | null;
  /** Surface of the active group; `null` when there is no group. */
  surface: Surface | null;
  /**
   * Who would own a group created now — the project the tree is showing.
   * `null` when that project is not in the workspace (nothing to hang a
   * group from) and the overlay is all that is left.
   */
  projectId: string | null;
}): DocHost {
  if (world.groupId) return world.surface === "canvas" ? "overlay" : "pane";
  return world.projectId ? "group" : "overlay";
}
