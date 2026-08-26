/**
 * "Custos e uso" — the arithmetic behind the panel.
 *
 * The backend (`costs.rs`) hands over rows already bucketed by local day,
 * agent, project and model; this module folds them into what the screen
 * shows (totals, one table per axis, the bars per day) and formats the
 * numbers. Nothing here reads the disk or the clock: the window is computed
 * from a `now` the caller passes, so the panel can be tested on a fixed date.
 *
 * Two honesty rules the tests lock down: a bucket that mixes priced and
 * unpriced rows reports its cost as a *floor* (`priced: false`) instead of
 * pretending the unpriced part was free; and a window is counted in local
 * calendar days, the same way the backend stamped the rows.
 */
// i18n-scan: tables — `WINDOW_LABELS` is translated where the panel renders it.
import { locale, t } from "./i18n";
import type { UsageRow } from "./ipc";

export type { UsageRow } from "./ipc";

export type CostRange = 1 | 7 | 30;
export type GroupBy = "day" | "project" | "agent" | "model";

export const RANGES: readonly CostRange[] = [1, 7, 30];
export const RANGE_LABELS: Record<CostRange, string> = {
  1: "Hoje",
  7: "7 dias",
  30: "30 dias",
};

export interface Bucket {
  key: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of the rows that had a price; `null` when none had. */
  costUsd: number | null;
  /** `false` when at least one row of the bucket had no price — the sum is a floor. */
  priced: boolean;
  /** Sum of the rows' session counts — a session that spans two days counts twice. */
  sessions: number;
  rows: number;
}

function emptyBucket(key: string, label: string): Bucket {
  return {
    key,
    label,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: null,
    priced: true,
    sessions: 0,
    rows: 0,
  };
}

function fold(into: Bucket, r: UsageRow): void {
  into.input += r.input;
  into.output += r.output;
  into.cacheRead += r.cacheRead;
  into.cacheWrite += r.cacheWrite;
  into.sessions += r.sessions;
  into.rows += 1;
  if (r.costUsd === null) {
    into.priced = false;
  } else {
    into.costUsd = (into.costUsd ?? 0) + r.costUsd;
  }
}

function keyOf(r: UsageRow, by: GroupBy): [string, string] {
  switch (by) {
    case "day":
      return [r.day, dayLabel(r.day)];
    case "project":
      return [r.projectPath, projectLabel(r.projectPath)];
    case "agent":
      return [r.agent, r.agent];
    case "model":
      return [r.model || "?", r.model || t("(modelo desconhecido)")];
  }
}

/**
 * One bucket per distinct value of the axis. Days come in calendar order;
 * every other axis by cost, the unpriced buckets last, tokens breaking ties.
 */
export function bucketBy(rows: readonly UsageRow[], by: GroupBy): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const r of rows) {
    const [key, label] = keyOf(r, by);
    let b = map.get(key);
    if (!b) {
      b = emptyBucket(key, label);
      map.set(key, b);
    }
    fold(b, r);
  }
  const out = [...map.values()];
  if (by === "day") return out.sort((a, b) => a.key.localeCompare(b.key));
  return out.sort(
    (a, b) =>
      (b.costUsd ?? -1) - (a.costUsd ?? -1) ||
      b.input + b.output - (a.input + a.output) ||
      a.label.localeCompare(b.label),
  );
}

/** Everything in one bucket. */
export function totals(rows: readonly UsageRow[]): Bucket {
  const all = emptyBucket("total", t("Total"));
  for (const r of rows) fold(all, r);
  return all;
}

/** `YYYY-MM-DD` of a local instant — the backend's own stamp. */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** `26/08` for `2026-08-26` — month first in English. */
export function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  if (!d || !m) return day;
  return locale() === "en-US" ? `${m}/${d}` : `${d}/${m}`;
}

/** The local days of the window, oldest first: `days = 1` is today only. */
export function windowDays(opts: { days: number; now: Date }): string[] {
  const n = Math.max(1, opts.days);
  const out: string[] = [];
  for (let back = n - 1; back >= 0; back -= 1) {
    const d = new Date(opts.now.getFullYear(), opts.now.getMonth(), opts.now.getDate() - back);
    out.push(localDay(d));
  }
  return out;
}

/** The rows whose day falls inside the window. */
export function filterRange(rows: readonly UsageRow[], opts: { days: number; now: Date }): UsageRow[] {
  const first = windowDays(opts)[0];
  return rows.filter((r) => r.day >= first);
}

export interface DayPoint {
  day: string;
  label: string;
  costUsd: number | null;
  tokens: number;
}

/** One point per day of the window, in order, with zeros for the quiet days. */
export function daySeries(rows: readonly UsageRow[], opts: { days: number; now: Date }): DayPoint[] {
  const byDay = new Map(bucketBy(rows, "day").map((b) => [b.key, b]));
  return windowDays(opts).map((day) => {
    const b = byDay.get(day);
    return {
      day,
      label: dayLabel(day),
      costUsd: b?.costUsd ?? null,
      tokens: b ? b.input + b.output : 0,
    };
  });
}

/** `US$ 12,35`; a positive amount under a cent says so instead of rounding to zero; `—` for no estimate. */
export function formatUsd(n: number | null): string {
  if (n === null) return "—";
  const en = locale() === "en-US";
  if (n > 0 && n < 0.005) return en ? "< US$ 0.01" : "< US$ 0,01";
  const fixed = n.toFixed(2);
  return `US$ ${en ? fixed : fixed.replace(".", ",")}`;
}

/** `980`, `3,4 mil`, `12 mil`, `1,2 mi`, `150 mi` — `3.4k`, `1.2M` in English. */
export function formatTokens(n: number): string {
  const en = locale() === "en-US";
  const scaled = (value: number, unit: string, enUnit: string) => {
    const digits = value >= 10 ? 0 : 1;
    const fixed = value.toFixed(digits);
    return en ? `${fixed}${enUnit}` : `${fixed.replace(".", ",")} ${unit}`;
  };
  if (n >= 1_000_000) return scaled(n / 1_000_000, "mi", "M");
  if (n >= 1_000) return scaled(n / 1_000, "mil", "k");
  return String(n);
}

/** The folder name of a project path, on either separator. */
export function projectLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last ?? t("(sem projeto)");
}
