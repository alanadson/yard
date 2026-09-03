/**
 * Where the portals have been, offered back while an address is typed.
 *
 * One list for every portal and every browser tab: an address is an
 * address, whichever card visited it. Pure over the list; the store keeps
 * it in the kv (`portal.history`).
 */

export interface Visit {
  url: string;
  lastAt: number;
  count: number;
}

/** Past this many the tail is forgotten; nobody scrolls a list that long. */
export const HISTORY_CAP = 300;

function skip(url: string): boolean {
  const u = url.trim();
  return !u || u === "about:blank" || /^about:/i.test(u);
}

/** The list with `url` moved (or added) to the front and counted. */
export function recordVisit(list: readonly Visit[], url: string, now: number): Visit[] {
  const u = url.trim();
  if (skip(u)) return [...list];
  const prev = list.find((v) => v.url === u);
  const rest = list.filter((v) => v.url !== u);
  return [{ url: u, lastAt: now, count: (prev?.count ?? 0) + 1 }, ...rest].slice(0, HISTORY_CAP);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  }
}

/**
 * What to offer for `query`: the host starting with it first, then any
 * address containing it; ties go to the more recent. Empty query = recent.
 */
export function suggestUrls(list: readonly Visit[], query: string, limit = 8): Visit[] {
  const q = query.trim().toLowerCase().replace(/^https?:\/\//, "");
  const recent = [...list].sort((a, b) => b.lastAt - a.lastAt);
  if (!q) return recent.slice(0, limit);
  const rank = (v: Visit): number => {
    const host = hostOf(v.url).toLowerCase();
    const whole = v.url.toLowerCase();
    if (host.startsWith(q)) return 2;
    if (whole.includes(q)) return 1;
    return 0;
  };
  return recent
    .map((v) => ({ v, r: rank(v) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r || b.v.lastAt - a.v.lastAt)
    .slice(0, limit)
    .map((x) => x.v);
}

/** The kv's list, junk dropped row by row. */
export function normalizeVisits(raw: unknown): Visit[] {
  if (!Array.isArray(raw)) return [];
  const out: Visit[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const v = r as Partial<Visit>;
    if (typeof v.url !== "string" || skip(v.url)) continue;
    out.push({
      url: v.url.trim(),
      lastAt: typeof v.lastAt === "number" && Number.isFinite(v.lastAt) ? v.lastAt : 0,
      count: typeof v.count === "number" && v.count > 0 ? Math.round(v.count) : 1,
    });
  }
  return out.slice(0, HISTORY_CAP);
}
