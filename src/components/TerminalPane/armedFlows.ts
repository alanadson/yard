import type { CanvasData } from "../../lib/canvas";
import { armsEnter, flowsOf } from "../../lib/flow";
import { stableSelect } from "../../lib/stableSelect";

interface ArmedFlow {
  name: string;
  stageCount: number;
}

/** Each pane keeps a projection of the badges it actually paints. */
export function armedFlowsSelector(terminalIds: readonly string[]) {
  const pane = new Set(terminalIds);
  return stableSelect((canvas: CanvasData | undefined): Record<string, ArmedFlow> => {
    const armed: Record<string, ArmedFlow> = {};
    if (!canvas) return armed;
    // Index the pane's wires once instead of scanning the canvas for every pair.
    const wired = new Map<string, Set<string>>();
    const add = (flowId: string, terminalId: string) => {
      if (!pane.has(terminalId)) return;
      let terminals = wired.get(flowId);
      if (!terminals) wired.set(flowId, terminals = new Set());
      terminals.add(terminalId);
    };
    for (const item of canvas.items) {
      if (item.type !== "connection") continue;
      add(item.from, item.to);
      add(item.to, item.from);
    }
    for (const flow of flowsOf(canvas)) {
      if (!armsEnter(flow) || !flow.stages.length) continue;
      for (const id of wired.get(flow.id) ?? []) {
        armed[id] = { name: flow.name, stageCount: flow.stages.length };
      }
    }
    return armed;
  }, (left, right) => {
    const ids = Object.keys(left);
    return ids.length === Object.keys(right).length && ids.every((id) =>
      left[id].name === right[id]?.name && left[id].stageCount === right[id]?.stageCount);
  });
}
