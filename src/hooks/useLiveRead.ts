/**
 * `lib/liveRead.ts` bound to the real window: its visibility comes from
 * `window://shown` (`lib/windowShown.ts`) and its safety tick from
 * `window.setInterval`. The rule itself (when a read happens) is tested
 * there; this file only plugs it in.
 */
import { LIVE_FALLBACK_MS, startLiveRead, type LiveReadOptions } from "../lib/liveRead";
import { isWindowShown, subscribeWindowShown } from "../lib/windowShown";

export function startWindowLiveRead(
  options: Pick<LiveReadOptions, "read" | "events" | "onError"> & { fallbackMs?: number },
): () => void {
  return startLiveRead({
    ...options,
    fallbackMs: options.fallbackMs ?? LIVE_FALLBACK_MS,
    visibility: { get: isWindowShown, subscribe: subscribeWindowShown },
    every: (tick, ms) => {
      const timer = window.setInterval(tick, ms);
      return () => window.clearInterval(timer);
    },
  });
}
