/** Docking preserves the original geometry and gives each screen edge one owner. */
import { expect, it } from "vitest";
import {
  EMPTY_CANVAS,
  normalizeCanvas,
  reconcileNodes,
  reconcileItems,
  type CanvasData,
} from "./canvas";
import { dockWorldRect, setDock, undockCopy } from "./canvasDock";
import { pinnedIds } from "./cardChrome";

it("copies a docked card onto its saved canvas rectangle without claiming the same edge", () => {
  const saved = {
    x: 150,
    y: 200,
    w: 600,
    h: 400,
    dock: "left" as const,
    contentHidden: true,
  };
  const copy = undockCopy(saved);
  expect(copy).toEqual({ x: 150, y: 200, w: 600, h: 400, contentHidden: true });
  expect(saved.dock).toBe("left");
});

it("docks an automatically placed terminal and restores its initial rectangle", () => {
  const initial = { x: 600, y: 150, w: 600, h: 400 };
  const docked = setDock(EMPTY_CANVAS, "new-agent", "right", initial);
  expect(docked.nodes["new-agent"]).toEqual({ ...initial, dock: "right" });
  expect(setDock(docked, "new-agent", undefined).nodes["new-agent"]).toEqual(
    initial,
  );
});

it("drops invalid docking metadata from saved drawings", () => {
  const restored = normalizeCanvas({
    ...EMPTY_CANVAS,
    items: [
      {
        id: "note",
        type: "note",
        x: 0,
        y: 0,
        w: 250,
        h: 170,
        text: "",
        color: "#fff",
        dock: "ceiling",
      },
      {
        id: "line",
        type: "line",
        x1: 0,
        y1: 0,
        x2: 10,
        y2: 10,
        color: "#fff",
        size: "s",
        dock: "left",
      },
    ],
  })!;
  expect(restored.items.map((item) => item.dock)).toEqual([
    undefined,
    undefined,
  ]);
});

it("keeps a docked card on the same screen edge after panning and zooming", () => {
  const screen = { w: 1000, h: 600 };
  expect(dockWorldRect("left", { x: 0, y: 0, zoom: 1 }, screen)).toEqual({
    x: 56,
    y: 12,
    w: 400,
    h: 576,
  });
  expect(dockWorldRect("left", { x: 100, y: 200, zoom: 0.5 }, screen)).toEqual({
    x: 212,
    y: 224,
    w: 800,
    h: 1152,
  });
  expect(
    pinnedIds({
      ...EMPTY_CANVAS,
      nodes: { agent: { x: 0, y: 0, w: 600, h: 400, dock: "left" } },
    }),
  ).toEqual(new Set(["agent"]));
});

it("moves edge ownership between cards and restores their original positions when released", () => {
  const source: CanvasData = {
    ...EMPTY_CANVAS,
    nodes: { agent: { x: 150, y: 200, w: 600, h: 400 } },
    items: [
      {
        id: "note",
        type: "note",
        x: 700,
        y: 80,
        w: 250,
        h: 170,
        text: "Brief",
        color: "#fff",
      },
    ],
  };
  const first = normalizeCanvas(setDock(source, "agent", "left"))!;
  expect(reconcileNodes(source.nodes, first.nodes).agent).toEqual({
    ...source.nodes.agent,
    dock: "left",
  });
  const second = normalizeCanvas(setDock(first, "note", "left"))!;
  expect(second.nodes.agent.dock).toBeUndefined();
  expect(reconcileItems(source.items, second.items)[0]).toMatchObject({
    ...source.items[0],
    dock: "left",
  });
  expect(setDock(second, "note", undefined).items[0]).toMatchObject(
    source.items[0],
  );
});
