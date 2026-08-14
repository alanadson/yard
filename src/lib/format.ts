/**
 * Number, time and duration formatting shown to the user.
 *
 * These were private helpers in five different components (`ago`, `fmt`,
 * `trunc`, `fmtClock`, `fmtElapsed`, `range`), which meant the same elapsed
 * time could read "2min" in one panel and "2m03s" in another, and none of it
 * was covered by a test.
 */

/** Compact token count: `1.2k`, `3.4M`. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Short relative age of an event: `agora`, `12s`, `4min`, `2h`. */
export function ago(ms: number): string {
  if (ms < 10_000) return "agora";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}min`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

/** Duration of something still running: `43s`, `2m07s`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Wall clock of an event, 24h. Empty for a missing timestamp. */
export function clock(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString("pt-BR", { hour12: false });
}

/** Size in kB, one decimal — the granularity a session list needs. */
export function kb(bytes: number, digits = 0): string {
  return `${(bytes / 1024).toFixed(digits)} KB`;
}

/** Cuts with an ellipsis; never returns more than `max` visible characters. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** `[start, end)` as an array — the `for` loop JSX cannot express. */
export function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
}
