/**
 * When the UI asks the backend to re-read agent usage now (`usage_refresh`).
 *
 * The backend polls on its own; a nudge only brings the next read forward at
 * the moment usage has probably moved (an agent finished a turn, the window
 * came back). Three rules keep the nudges from becoming a poll of their own:
 * the nudge names the provider of the agent that stopped (an idle Gemini or a
 * shell spends nothing Yard reads), two nudges of the same provider are a
 * minute apart, and a hidden window asks nothing.
 *
 * The clock and the window state come in as parameters: no timers here.
 */
import { brandOf } from "./brands";

/** The providers the usage strip reads (`usage.rs`). */
export type UsageProvider = "claude" | "codex" | "grok";

/** Between two nudges of the same provider. */
export const USAGE_NUDGE_FLOOR_MS = 60_000;

/** The usage provider an agent spends, or `null` for one Yard does not read. */
export function usageProviderOf(
  terminal: { agentId?: string | null; program: string } | undefined,
): UsageProvider | null {
  if (!terminal) return null;
  const brand = brandOf(terminal);
  return brand === "claude" || brand === "codex" || brand === "grok" ? brand : null;
}

export interface NudgeGate {
  /**
   * Should a nudge for `provider` (`undefined` = every provider) go out now?
   * A yes is remembered: the next one of the same kind waits the floor.
   */
  take(provider: UsageProvider | undefined, now: number, shown: boolean): boolean;
}

export function createNudgeGate(floorMs = USAGE_NUDGE_FLOOR_MS): NudgeGate {
  const ALL = "*";
  const last = new Map<string, number>();
  const since = (key: string, now: number) => now - (last.get(key) ?? -Infinity);
  return {
    take(provider, now, shown) {
      if (!shown) return false;
      const key = provider ?? ALL;
      // A nudge for everyone already covered this provider.
      const recent = Math.min(since(key, now), since(ALL, now));
      if (recent < floorMs) return false;
      last.set(key, now);
      return true;
    },
  };
}
