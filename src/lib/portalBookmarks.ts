/**
 * Starred addresses, shared by every portal and browser tab.
 *
 * Pure over the list; the store keeps it in the kv (`portal.bookmarks`).
 */

export interface Bookmark {
  url: string;
  name: string;
}

/** `https://a.dev/` and `https://a.dev` are one address. */
function key(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url;
  }
}

export function isBookmarked(list: readonly Bookmark[], url: string): boolean {
  const k = key(url);
  return list.some((b) => key(b.url) === k);
}

/** Stars the address, or unstars it when it already is. */
export function toggleBookmark(list: readonly Bookmark[], mark: Bookmark): Bookmark[] {
  if (isBookmarked(list, mark.url)) {
    const k = key(mark.url);
    return list.filter((b) => key(b.url) !== k);
  }
  const name = mark.name.trim() || hostOf(mark.url);
  return [...list, { url: mark.url.trim(), name }];
}

/** The kv's list: rows with a url only, no duplicates, a name always. */
export function normalizeBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: Bookmark[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const b = r as Partial<Bookmark>;
    if (typeof b.url !== "string" || !b.url.trim()) continue;
    const k = key(b.url);
    if (seen.has(k)) continue;
    seen.add(k);
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : hostOf(b.url);
    out.push({ url: b.url.trim(), name });
  }
  return out;
}
