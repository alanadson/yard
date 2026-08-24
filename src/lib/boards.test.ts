/**
 * Boards did not exist: a canvas was a mode of a group, so every board anyone
 * ever drew is sitting inside `layoutJson.canvas` of some group of some
 * project. This is the one-way trip that takes those out and makes each of
 * them a board of its own — and the rule that matters is that **nothing is
 * left behind**: the cards, the drawings, the notes, the roles and the wires
 * all travel, and the group keeps its tabs.
 */
import { describe, expect, it } from "vitest";

import { extractBoards } from "./boards";
import type { GroupRow, TerminalRow } from "./ipc";

const project = (id: string, name: string) => ({ id, name });

function group(id: string, projectId: string | null, name: string, layout: object): GroupRow {
  return {
    id,
    projectId,
    name,
    layoutJson: JSON.stringify(layout),
    suspended: false,
    sort: 0,
  };
}

function terminal(id: string, groupId: string, surface: "grid" | "canvas"): TerminalRow {
  return {
    id,
    groupId,
    slot: 0,
    surface,
    kind: "shell",
    program: "pwsh",
    args: [],
    cwd: "C:/Workspace/x",
    sort: 0,
    alive: false,
    createdAt: 0,
  };
}

const drawnOn = {
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: { card: { x: 10, y: 20, w: 640, h: 380 } },
  items: [{ id: "n1", type: "note", color: "#fff", x: 0, y: 0, w: 200, h: 120, text: "oi" }],
};

describe("extractBoards", () => {
  it("a group with something drawn on its canvas becomes a board named after both", () => {
    const out = extractBoards(
      [project("p1", "yard")],
      [group("g1", "p1", "Grupo 1", { mode: "spotlight", surface: "canvas", canvas: drawnOn })],
      [terminal("card", "g1", "canvas"), terminal("tab", "g1", "grid")],
    );

    expect(out.changed).toBe(true);
    const board = out.groups.find((g) => g.projectId === null)!;
    expect(board.name).toBe("yard · Grupo 1");
    // Everything that was on the board went with it.
    const layout = JSON.parse(board.layoutJson);
    expect(layout.surface).toBe("canvas");
    expect(layout.canvas.nodes).toEqual(drawnOn.nodes);
    expect(layout.canvas.items).toEqual(drawnOn.items);
    // The cards moved; the tab stayed.
    expect(out.terminals.find((t) => t.id === "card")?.groupId).toBe(board.id);
    expect(out.terminals.find((t) => t.id === "tab")?.groupId).toBe("g1");
  });

  it("the group it came from keeps its tabs and stops carrying a canvas", () => {
    const out = extractBoards(
      [project("p1", "yard")],
      [group("g1", "p1", "Grupo 1", { mode: "spotlight", panelCount: 3, surface: "canvas", canvas: drawnOn })],
      [terminal("tab", "g1", "grid")],
    );

    const kept = JSON.parse(out.groups.find((g) => g.id === "g1")!.layoutJson);
    expect(kept.canvas).toBeUndefined();
    // Back on the panes, with the shape the user had pinned untouched.
    expect(kept.surface).toBe("grid");
    expect(kept.mode).toBe("spotlight");
    expect(kept.panelCount).toBe(3);
  });

  /** A canvas nobody ever drew on is not a board — it is an empty field. */
  it("an untouched canvas produces no board at all", () => {
    const empty = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {}, items: [] };
    const out = extractBoards(
      [project("p1", "yard")],
      [
        group("g1", "p1", "Sem nada", { mode: "auto", canvas: empty }),
        group("g2", "p1", "Nunca abriu", { mode: "auto" }),
      ],
      [],
    );

    expect(out.changed).toBe(false);
    expect(out.groups.some((g) => g.projectId === null)).toBe(false);
  });

  /** Drawings with no card at all are still a board someone made. */
  it("a canvas with only drawings still becomes a board", () => {
    const out = extractBoards(
      [project("p1", "yard")],
      [group("g1", "p1", "Rascunho", { mode: "auto", canvas: { ...drawnOn, nodes: {} } })],
      [],
    );

    expect(out.groups.filter((g) => g.projectId === null)).toHaveLength(1);
  });

  it("boards already there are left exactly as they are", () => {
    const existing = group("b0", null, "Meu quadro", { surface: "canvas", canvas: drawnOn });
    const out = extractBoards([project("p1", "yard")], [existing], []);

    expect(out.changed).toBe(false);
    expect(out.groups).toEqual([existing]);
  });

  it("each canvas becomes its own board, in the order the groups come", () => {
    const out = extractBoards(
      [project("p1", "yard"), project("p2", "Interagia")],
      [
        group("g1", "p1", "Grupo 1", { canvas: drawnOn }),
        group("g2", "p2", "Principal", { canvas: drawnOn }),
      ],
      [],
    );

    const boards = out.groups.filter((g) => g.projectId === null);
    expect(boards.map((b) => b.name)).toEqual(["yard · Grupo 1", "Interagia · Principal"]);
    expect(boards.map((b) => b.sort)).toEqual([0, 1]);
  });

  /**
   * The screen must not move: whoever was looking at a canvas when the app
   * closed has to reopen on the board that canvas became, not on the panes
   * behind it.
   */
  it("says which board each canvas turned into, so the screen can follow", () => {
    const out = extractBoards(
      [project("p1", "yard")],
      [group("g1", "p1", "Grupo 1", { surface: "canvas", canvas: drawnOn })],
      [],
    );

    const board = out.groups.find((g) => g.projectId === null)!;
    expect(out.boardOf.get("g1")).toBe(board.id);
  });

  /**
   * The group left behind must not keep `mode: "canvas"` written in it. It
   * still *read* correctly — an explicit `surface` wins over what the legacy
   * mode implied — but it left dead, contradictory data on disk, and the
   * layout switch is a readout of that field.
   */
  it("the group left behind stops claiming a canvas mode that no longer exists", () => {
    const out = extractBoards(
      [project("p1", "yard")],
      [group("g1", "p1", "Grupo 1", { mode: "canvas", panelCount: 3, canvas: drawnOn })],
      [],
    );

    const kept = JSON.parse(out.groups.find((g) => g.id === "g1")!.layoutJson);
    expect(kept.mode).toBe("auto");
    expect(kept.surface).toBe("grid");
  });

  /**
   * The regression this locks down, and the app is the only place it showed
   * up: `load` runs twice at boot (and again whenever a save is refused for a
   * stale revision). While the id was minted fresh each time, the second pass
   * over the same snapshot produced a **second** board from the same group —
   * and the selection, pointing at the first one, fell back to a group the
   * user was not looking at.
   */
  it("running twice over the same group gives the same board, not a second one", () => {
    const groups = [group("g1", "p1", "Grupo 1", { canvas: drawnOn })];
    const first = extractBoards([project("p1", "yard")], groups, []);
    const again = extractBoards([project("p1", "yard")], groups, []);

    const idOf = (r: typeof first) => r.groups.find((g) => g.projectId === null)!.id;
    expect(idOf(again)).toBe(idOf(first));
    expect(again.boardOf.get("g1")).toBe(first.boardOf.get("g1"));
  });

  it("a group with no project of its own is named after the group alone", () => {
    const out = extractBoards(
      [],
      [group("g1", "p-sumiu", "Órfão", { canvas: drawnOn })],
      [],
    );

    expect(out.groups.find((g) => g.projectId === null)?.name).toBe("Órfão");
  });
});
