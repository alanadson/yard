/**
 * Which pane group owns the title bar's layout controls.
 *
 * A standalone board has no panes, but the switch must not disappear while it
 * is selected: the group the user came from still owns Auto/Grade/Holofote,
 * and Canvas describes the surface currently in front of them.
 */
import type { Surface } from "../../lib/surface";

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
  const fallback = groups.find((group) => group.projectId === activeProjectId);
  const target = remembered ?? fallback;
  return target ? { groupId: target.id, canvasActive: true } : null;
}
