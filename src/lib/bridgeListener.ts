import { ipc, on, type BridgeResponse } from "./ipc";
import { AsyncDisposer } from "./disposables";
import { uiLog } from "./log";

/**
 * Lightweight startup listener. The command engine is downloaded only when a
 * CLI actually calls the bridge (or when the lazy prompt composer needs it).
 */
export function startBridge(
  onError: (error: unknown) => void = (error) => uiLog.warn(`Bridge registration failed: ${error}`),
): () => void {
  const owner = new AsyncDisposer(onError);
  void owner.add(on.bridgeRequest(async ({ id, request }) => {
      let response: BridgeResponse;
      try {
        const { handleBridgeRequest } = await import("./bridge");
        response = await handleBridgeRequest(request);
      } catch (error) {
        response = { code: 1, output: `yard: erro interno: ${error}\n` };
      }
      void ipc.bridgeRespond(id, response).catch(() => {});
    }));
  return () => owner.dispose();
}
