/**
 * How much of the machine's RAM is in use, and whether that is a problem.
 *
 * Read by the sidebar HUD (bar + tooltip) and by the status bar (compact
 * meter). One pair of thresholds for both: the sidebar had them inline, and a
 * second copy would be the kind that drifts the first time someone tunes one.
 */
export type RamLevel = "ok" | "warn" | "crit";

export interface RamPressure {
  /** Share of RAM in use, 0..1. */
  usage: number;
  /** The same share as a whole percent, for labels. */
  pct: number;
  level: RamLevel;
}

/** `null` while the backend has not said how much RAM there is. */
export function ramPressure(availableMb: number, totalMb: number): RamPressure | null {
  if (totalMb <= 0) return null;
  const usage = Math.min(1, Math.max(0, 1 - availableMb / totalMb));
  const level: RamLevel = usage > 0.92 ? "crit" : usage > 0.82 ? "warn" : "ok";
  return { usage, pct: Math.round(usage * 100), level };
}
