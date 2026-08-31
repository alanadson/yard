/**
 * What "clonar o layout do chão" means once the two surfaces stopped being
 * the same place.
 *
 * It used to mean applying a score, which is the canvas format: the ground's
 * *cards*, their wires and their roles, landing on a group that the score
 * itself then turned to the canvas. A front is not a board — it is opened to
 * hold panes — so the clone reads the grid and nothing else. What is on the
 * ground's canvas stays on the ground's canvas.
 */
import { describe, expect, it } from "vitest";

import { groundClone, type ClonableTab } from "./groundClone";

const SHAPE = { mode: "auto", panelCount: 2 } as const;

function tab(over: Partial<ClonableTab> = {}): ClonableTab {
  return {
    title: "dev",
    kind: "shell",
    agentId: null,
    program: "pwsh.exe",
    args: [],
    slot: 0,
    sort: 0,
    surface: "grid",
    ...over,
  };
}

describe("groundClone", () => {
  it("carries the shape of the panes the ground had", () => {
    const clone = groundClone({ mode: "spotlight", panelCount: 4 }, []);
    expect(clone).toEqual({ mode: "spotlight", panelCount: 4, tabs: [] });
  });

  it("takes the grid's tabs and refuses the canvas's cards", () => {
    const clone = groundClone(SHAPE, [
      tab({ title: "dev" }),
      tab({ title: "card", surface: "canvas", sort: 1 }),
      tab({ title: "logs", sort: 2 }),
    ]);
    expect(clone.tabs.map((t) => t.title)).toEqual(["dev", "logs"]);
  });

  it("keeps each tab in its own pane, in the order that pane's bar shows", () => {
    const clone = groundClone(SHAPE, [
      tab({ title: "b", slot: 0, sort: 3 }),
      tab({ title: "z", slot: 1, sort: 1 }),
      tab({ title: "a", slot: 0, sort: 2 }),
    ]);
    expect(clone.tabs.map((t) => [t.title, t.slot])).toEqual([
      ["a", 0],
      ["b", 0],
      ["z", 1],
    ]);
  });

  it("carries what identifies the CLI, and never an id, a process or a cwd", () => {
    const [cloned] = groundClone(SHAPE, [
      tab({ title: "Claude", kind: "agent", agentId: "claude", args: ["--yolo"], pinned: true }),
    ]).tabs;
    expect(cloned).toEqual({
      title: "Claude",
      kind: "agent",
      agentId: "claude",
      program: "pwsh.exe",
      args: ["--yolo"],
      slot: 0,
      pinned: true,
    });
  });

  it("names a nameless tab after its program — a tab with no label is not a clone of anything", () => {
    const clone = groundClone(SHAPE, [tab({ title: null })]);
    expect(clone.tabs[0].title).toBe("pwsh.exe");
  });

  it("a surface written before the split is read as the grid, like everywhere else", () => {
    const clone = groundClone(SHAPE, [tab({ surface: null })]);
    expect(clone.tabs).toHaveLength(1);
  });
});
