// Pane badges must follow wiring edits without repainting for unrelated canvas content.
import { expect, it } from "vitest";
import { EMPTY_CANVAS, type CanvasData } from "../../lib/canvas";
import type { FlowItem } from "../../lib/flow";
import { armedFlowsSelector } from "./armedFlows";

// `trigger: true` because the contract changed: a wire alone no longer arms
// the Enter interception, only a trigger the user switched on does.
it("invalidates armed flow badges only when the pane's visible flow bindings change", () => {
  const flow: FlowItem = {
    id: "flow", type: "flow", name: "Review", color: "#fff",
    x: 0, y: 0, w: 270, h: 160,
    stages: [{ label: "Check", prompt: "Review the change" }],
    trigger: true,
  };
  const canvas: CanvasData = { ...EMPTY_CANVAS, items: [flow] };
  const select = armedFlowsSelector(["agent", "other"]);
  expect(select(canvas)).toEqual({});
  const wired: CanvasData = { ...canvas, items: [...canvas.items, {
    id: "wire", type: "connection", from: "agent", to: "flow", color: "#fff",
  }, { id: "other-wire", type: "connection", from: "flow", to: "other", color: "#fff" }] };
  const badges = select(wired);
  expect(badges).toEqual({
    agent: { name: "Review", stageCount: 1 },
    other: { name: "Review", stageCount: 1 },
  });
  expect(select({ ...wired, items: [...wired.items, {
    id: "note", type: "text", x: 0, y: 0, text: "Edited", fontSize: 16, color: "#fff",
  }] })).toBe(badges);
  expect(select(canvas)).toEqual({});
});

it("paints no badge for a wired flow whose trigger was never switched on", () => {
  const flow: FlowItem = {
    id: "flow", type: "flow", name: "Review", color: "#fff",
    x: 0, y: 0, w: 270, h: 160,
    stages: [{ label: "Check", prompt: "Review the change" }],
  };
  const wired: CanvasData = { ...EMPTY_CANVAS, items: [flow, {
    id: "wire", type: "connection", from: "agent", to: "flow", color: "#fff",
  }] };
  expect(armedFlowsSelector(["agent"])(wired)).toEqual({});
});
