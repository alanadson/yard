/**
 * Runs an IPC call and turns a failure into a toast instead of an unhandled
 * rejection.
 *
 * Every surface that can restart, suspend or kill a PTY had its own private
 * copy of this three-line `try/catch`. The message matters: these calls fail
 * for real reasons (the process already died, the backend is busy) and a
 * silent button is indistinguishable from a broken one.
 */
import { useCallback } from "react";

import { useUI } from "../stores/uiStore";

export type Action = (fn: () => Promise<unknown>, err: string) => Promise<void>;

export function useAction(): Action {
  const showToast = useUI((s) => s.showToast);
  return useCallback(
    async (fn, error) => {
      try {
        await fn();
      } catch (e) {
        showToast(`${error}: ${e}`, "error");
      }
    },
    [showToast],
  );
}
