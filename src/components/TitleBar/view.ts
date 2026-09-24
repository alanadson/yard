/**
 * What the title bar reads from the workspace store.
 *
 * The bar paints a breadcrumb (the project, the group, the floor's branch)
 * and the pane switch (mode and pane count of the group that owns the
 * panes). It used to subscribe to the whole `groups` array to find those,
 * and that array is rewritten by every canvas keystroke, viewport pan and
 * tab click in the workspace, so the bar re-rendered on each of them.
 * `titleBarView` is the projection of exactly what it paints, and
 * `titleBarSelector` keeps the previous one while it is equal, so Zustand
 * only re-renders the bar when the picture would change.
 */
import type { GroupRow, ProjectRow } from "../../lib/ipc";
import type { FloorMeta } from "../../lib/floors";
import { layoutControlsState, type LayoutControlsState } from "../../lib/layoutControls";
import { stableSelect } from "../../lib/stableSelect";
import { parseLayout, type LayoutMode } from "../../stores/projectsStore";

/** The slice of the workspace store the view is built from. */
export interface TitleBarSource {
  projects: ProjectRow[];
  groups: GroupRow[];
  activeGroupId: string | null;
  activeProjectId: string | null;
  groupBeforeBoard: string | null;
}

export interface TitleBarView {
  /** The group on screen: its name, and whether it is a board (`projectId` null). */
  group: { id: string; name: string; projectId: string | null } | null;
  /** The project the group on screen belongs to; none for a board. */
  project: ProjectRow | undefined;
  /** The floor of the group on screen, for the crumb's label and branch. */
  floor: FloorMeta | undefined;
  /** Which group the pane switch talks about (`lib/layoutControls.ts`). */
  controls: LayoutControlsState | null;
  /** The pane shape the switch paints, of the group in `controls`. */
  layout: { mode: LayoutMode; panelCount: number } | null;
}

export function titleBarView(s: TitleBarSource): TitleBarView {
  const active = s.groups.find((g) => g.id === s.activeGroupId);
  const project = active ? s.projects.find((p) => p.id === active.projectId) : undefined;
  // The crumb only prints the floor on a project's group; a board's layout is
  // the big one (the whole canvas) and nothing here reads its floor.
  const floor =
    active && active.projectId !== null ? parseLayout(active.layoutJson).floor : undefined;
  const controls = layoutControlsState({
    activeGroupId: s.activeGroupId,
    activeProjectId: s.activeProjectId,
    groupBeforeBoard: s.groupBeforeBoard,
    groups: s.groups,
  });
  const controlGroup = controls ? s.groups.find((g) => g.id === controls.groupId) : undefined;
  const controlLayout = controlGroup ? parseLayout(controlGroup.layoutJson) : null;
  return {
    group: active ? { id: active.id, name: active.name, projectId: active.projectId } : null,
    project,
    floor,
    controls,
    layout: controlLayout
      ? { mode: controlLayout.mode, panelCount: controlLayout.panelCount }
      : null,
  };
}

/**
 * Two views are the same picture when they serialise the same: the view is
 * small, plain data (a few names, a floor, two numbers), so this is cheap,
 * and it compares every field the bar paints without a list to keep in sync.
 */
export function sameTitleBarView(a: TitleBarView, b: TitleBarView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One per mounted title bar: it remembers the view it handed out last. */
export function titleBarSelector(): (s: TitleBarSource) => TitleBarView {
  return stableSelect(titleBarView, sameTitleBarView);
}
