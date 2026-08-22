import { ipc, on, type BridgeResponse } from "./ipc";

/**
 * Lightweight startup listener. The command engine is downloaded only when a
 * CLI actually calls the bridge (or when the lazy prompt composer needs it).
 */
export function startBridge(): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void on
    .bridgeRequest(async ({ id, request }) => {
      let response: BridgeResponse;
      try {
        const { handleBridgeRequest } = await import("./bridge");
        response = await handleBridgeRequest(request);
      } catch (error) {
        response = { code: 1, output: `yard: erro interno: ${error}\n` };
      }
      void ipc.bridgeRespond(id, response).catch(() => {});
    })
    .then((dispose) => {
      if (stopped) dispose();
      else unlisten = dispose;
    });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
