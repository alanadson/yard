import { autoNodeRect, type CanvasData, type CanvasNode } from "./canvas";
import { commitCanvasExternal } from "./canvasWrite";
import type { Ctx } from "./bridgeCore";

export function commitBridgeCanvas(
  groupId: string,
  change: (canvas: CanvasData) => CanvasData,
): void {
  commitCanvasExternal(groupId, change);
}

/** Resting rectangle of the caller, including cards never explicitly moved. */
export function bridgeCallerRect(ctx: Ctx): CanvasNode {
  return (
    ctx.canvas.nodes[ctx.caller.id] ??
    autoNodeRect(
      ctx.terminals.findIndex((terminal) => terminal.id === ctx.caller.id),
    )
  );
}
