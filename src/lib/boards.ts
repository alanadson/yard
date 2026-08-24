/**
 * Boards ("quadros"): the canvas as its own container.
 *
 * A board belongs to no project — it holds cards from several at once, which
 * is the whole reason it exists — and it is modeled as a group with
 * `projectId === null`. That single rule is the definition; there is no second
 * flag that could disagree with it.
 *
 * What lives here is the **one-way trip** out of the old model. Before boards,
 * a canvas was a mode of a group, so every board anyone ever drew is sitting
 * in `layoutJson.canvas` of some group of some project. `extractBoards` takes
 * each of those out and makes it a board, once, on the first load after the
 * change.
 */
import { normalizeCanvas } from "./canvas";
import type { GroupRow, TerminalRow } from "./ipc";
import { onSurface, splitLegacyMode } from "./surface";

/** Enough of a project to name a board after it. */
interface NamedProject {
  id: string;
  name: string;
}

export interface ExtractResult {
  groups: GroupRow[];
  terminals: TerminalRow[];
  /** Nothing to do: no group was carrying a canvas worth taking out. */
  changed: boolean;
  /**
   * Old group id -> the board its canvas became. `load` uses it to keep the
   * screen still: whoever closed the app looking at a canvas has to reopen on
   * the board that canvas turned into, not on the panes behind it.
   */
  boardOf: Map<string, string>;
}

/**
 * A canvas is "in use" when someone put something on it — a card, a drawing,
 * a note. An untouched canvas is an empty field, not a board, and turning
 * those into rows would litter the bar with one entry per group ever visited.
 */
function inUse(canvas: { nodes: object; items: unknown[] } | undefined): boolean {
  if (!canvas) return false;
  return Object.keys(canvas.nodes).length > 0 || canvas.items.length > 0;
}

/**
 * The board's id is **derived** from the group it came from, never minted.
 *
 * That is what makes this migration idempotent, and it took the real app to
 * show why it has to be: `load` runs twice at boot, and again every time a
 * save is refused for a stale revision. With a fresh id per pass, the second
 * pass over the same snapshot produced a *second* board out of the same group
 * — and the selection, pointing at the first, fell back to a group the user
 * was not even looking at.
 */
function boardIdFor(groupId: string): string {
  return `board-${groupId}`;
}

export function extractBoards(
  projects: NamedProject[],
  groups: GroupRow[],
  terminals: TerminalRow[],
): ExtractResult {
  const nameOf = new Map(projects.map((p) => [p.id, p.name] as const));
  const boardOf = new Map<string, string>();
  const nextGroups: GroupRow[] = [];
  const boards: GroupRow[] = [];
  // Past the last board that already exists, so a second run (or a board the
  // user made by hand) does not collide on `sort`.
  let sort = groups.reduce(
    (max, g) => (g.projectId === null ? Math.max(max, g.sort + 1) : max),
    0,
  );

  for (const group of groups) {
    // A board is already what it should be; nothing to extract from it.
    if (group.projectId === null) {
      nextGroups.push(group);
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(group.layoutJson || "{}");
    } catch {
      nextGroups.push(group);
      continue;
    }
    const canvas = normalizeCanvas(parsed.canvas);
    if (!inUse(canvas)) {
      nextGroups.push(group);
      continue;
    }

    const id = boardIdFor(group.id);
    boardOf.set(group.id, id);
    // `<projeto> · <grupo>`, so the user recognises where it came from. A
    // group whose project is gone is named after itself — better a bare name
    // than "undefined · Órfão".
    const projectName = nameOf.get(group.projectId);
    boards.push({
      id,
      projectId: null,
      name: projectName ? `${projectName} · ${group.name}` : group.name,
      layoutJson: JSON.stringify({
        mode: "auto",
        surface: "canvas",
        panelCount: 2,
        activeBySlot: {},
        canvas,
      }),
      suspended: false,
      sort: sort++,
    });

    // The group keeps its tabs and goes back to the panes: the canvas it was
    // showing is not in it any more. `floor` stays — an isolated worktree is a
    // property of the group, not of the board that came out of it.
    //
    // `mode` is normalized on the way out, not left as it was: a group written
    // before the surfaces were split can be holding the legacy `"canvas"`
    // there, and leaving it would put two contradictory statements in the same
    // JSON — the switch in the title bar is a readout of that field.
    const { canvas: _gone, ...withoutCanvas } = parsed;
    nextGroups.push({
      ...group,
      layoutJson: JSON.stringify({
        ...withoutCanvas,
        mode: splitLegacyMode(parsed.mode).mode,
        surface: "grid",
      }),
    });
  }

  if (!boards.length) return { groups, terminals, changed: false, boardOf };

  // The cards follow their canvas. Their `cwd` travels untouched, which is
  // exactly what lets one board end up mixing projects.
  const moved = terminals.map((t) => {
    const board = boardOf.get(t.groupId);
    if (!board) return t;
    return onSurface([t], "canvas").length ? { ...t, groupId: board } : t;
  });

  return {
    groups: [...nextGroups, ...boards],
    terminals: moved,
    changed: true,
    boardOf,
  };
}
