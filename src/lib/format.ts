/**
 * Number, time and duration formatting shown to the user.
 *
 * These were private helpers in five different components (`ago`, `fmt`,
 * `trunc`, `fmtClock`, `fmtElapsed`, `range`), which meant the same elapsed
 * time could read "2min" in one panel and "2m03s" in another, and none of it
 * was covered by a test.
 */

import { locale, t, tn } from "./i18n";

/** Compact token count: `1.2k`, `3.4M`. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Short relative age of an event: `agora`, `12s`, `4min`, `2h`. */
export function ago(ms: number): string {
  if (ms < 10_000) return t("agora");
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}min`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

/**
 * When a dated event happened — for the commit history, where the dates
 * range from seconds ago to years ago.
 *
 * Not the same problem as `ago`, which takes a **duration** and stops at
 * hours: a three-month-old commit came out of it as "2160h", which nobody
 * reads as time. Here the scale changes with the distance — minutes, hours,
 * days, and after a month the date itself, which is what the person really
 * wants to know.
 *
 * `at` in **seconds** (git's unit); the clock comes in as a parameter so the
 * result does not depend on when the test runs.
 */
export function since(at: number, now: number): string {
  if (!at) return "";
  const seconds = Math.floor(now / 1000 - at);
  // A skewed clock (the machine's, or the commit author's) does not go negative.
  if (seconds < 60) return t("agora");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86_400);
  if (days < 30) return tn(days, "{n} dia", "{n} dias");
  const data = new Date(at * 1000);
  const sameYear = data.getFullYear() === new Date(now).getFullYear();
  return data.toLocaleDateString(locale(), {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Duration of something still running: `43s`, `2m07s`. */
/**
 * Which shape `since` answered in — for a caller that phrases a sentence
 * around it ("há 5min" vs "em 12 de jul.") without reading the words back.
 */
export function sinceKind(at: number, now: number): "none" | "now" | "duration" | "date" {
  if (!at) return "none";
  const seconds = Math.floor(now / 1000 - at);
  if (seconds < 60) return "now";
  return seconds < 30 * 86_400 ? "duration" : "date";
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Wall clock of an event, 24h. Empty for a missing timestamp. */
export function clock(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString(locale(), { hour12: false });
}

/**
 * Compact "time until": `5d 11h`, `4h 05min`, `23min`, `<1min`.
 * Used by the usage meter for "reinicia em …" — days dominate weeks,
 * hours dominate a day, so two units are always enough.
 */
export function untilShort(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1min";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${String(min % 60).padStart(2, "0")}min`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
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
