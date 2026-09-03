/**
 * Cloning the ground into a new front.
 *
 * "Clonar o layout do chão" used to mean applying a **score**, and a score is
 * the canvas format: cards, wires, roles, positions. Two things followed from
 * that, and nobody had asked for either. The front was born with the ground's
 * *board* instead of its panes — so a ground whose work lives in tabs cloned
 * to nothing — and `applyScore`, landing on an empty group, turned that group
 * to the canvas. Opening a front therefore dropped the user on a board.
 *
 * The two surfaces are separate places (`lib/surface.ts`) and this is one of
 * the seams where they were still tied. A front is opened to hold panes, so
 * the clone reads the grid: which CLIs the ground has, in which pane, in the
 * order that pane's bar shows them, under the shape (`mode`/`panelCount`) the
 * panes were in. What is on the ground's canvas stays there.
 *
 * What never crosses: ids, live processes, and the working root — the front
 * has a worktree of its own, which is the entire point of it.
 */
import type { PtyKind, TerminalRow } from "./ipc";
import { baseName } from "./terminals";
import { normalizeSurface, type GridMode, type Surface } from "./surface";
import { useProjects } from "../stores/projectsStore";

/** A row of the ground, as much of it as the clone looks at. */
export interface ClonableTab {
  title?: string | null;
  kind: PtyKind;
  agentId?: string | null;
  program: string;
  args: string[];
  slot: number;
  sort: number;
  pinned?: boolean;
  surface?: Surface | null;
}

/** One tab to recreate: what identifies the CLI, and where its bar puts it. */
export interface ClonedTab {
  title: string;
  kind: PtyKind;
  agentId: string | null;
  program: string;
  args: string[];
  slot: number;
  pinned?: boolean;
}

export interface GroundClone {
  mode: GridMode;
  panelCount: number;
  /** In creation order: pane by pane, and inside each pane, bar order. */
  tabs: ClonedTab[];
}

export function groundClone(
  shape: { mode: GridMode; panelCount: number },
  terminals: ClonableTab[],
): GroundClone {
  const tabs = terminals
    .filter((t) => normalizeSurface(t.surface) === "grid")
    // Pane first, then the bar's own order. Recreating them in this order is
    // what reproduces it at the far end: `addTerminal` appends.
    .sort((a, b) => a.slot - b.slot || a.sort - b.sort)
    .map<ClonedTab>((t) => ({
      title: baseName(t as Pick<TerminalRow, "title" | "program">),
      kind: t.kind,
      agentId: t.agentId ?? null,
      program: t.program,
      args: t.args,
      slot: t.slot,
      ...(t.pinned ? { pinned: true } : {}),
    }));
  return { mode: shape.mode, panelCount: shape.panelCount, tabs };
}

/**
 * Recreates the clone inside `groupId`, stopped, rooted at `cwd`.
 *
 * Every tab is born on the grid, because the destination is a front, a
 * project's group, and a project's group draws tabs and nothing else: the
 * canvas is the boards (`lib/surface.ts`), and a front cannot land a CLI on
 * one.
 */
export function applyGroundClone(clone: GroundClone, groupId: string, cwd: string): void {
  const s = useProjects.getState();
  s.updateLayout(groupId, { mode: clone.mode, panelCount: clone.panelCount });
  for (const tab of clone.tabs) {
    const id = s.addTerminal({
      groupId,
      slot: tab.slot,
      title: tab.title,
      kind: tab.kind,
      agentId: tab.agentId,
      program: tab.program,
      args: tab.args,
      cwd,
    });
    // `addTerminal` has no pin of its own: pinning is a gesture on an existing
    // tab, and the clone is the only caller that starts one already pinned.
    if (tab.pinned) s.toggleTerminalPin(id);
  }
}

/** The ground's grid, ready to be recreated in `into`. */
export function cloneGroundInto(groundId: string, into: string, cwd: string): void {
  const s = useProjects.getState();
  const layout = s.layoutOf(groundId);
  applyGroundClone(
    groundClone({ mode: layout.mode, panelCount: layout.panelCount }, s.terminalsOf(groundId)),
    into,
    cwd,
  );
}
