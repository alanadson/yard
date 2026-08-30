/**
 * Line marks: the two or three places in a file you keep coming back to while
 * you are working on it.
 *
 * Deliberately dumber than a breakpoint. A set of lines per document, sorted,
 * persisted next to the open tabs, and no attempt to follow the text as it
 * is edited beyond `shiftFrom`, which exists for the one case the editor
 * really does know about: a file re-read from disk after an agent wrote to
 * it. Everything else is honest about drifting, because a mark that quietly
 * moves to the wrong line is worse than one the reader knows to re-place.
 */

/** Marked lines (0-based) per document id. A file with none has no entry. */
export type Bookmarks = Readonly<Record<string, readonly number[]>>;

export const NO_MARKS: Bookmarks = {};

/** The marks of one file, in reading order. */
export function linesOf(marks: Bookmarks, id: string): number[] {
  return [...(marks[id] ?? [])];
}

export function countOf(marks: Bookmarks, id: string): number {
  return marks[id]?.length ?? 0;
}

/** Puts a mark down, or takes back the one already on that line. */
export function toggle(marks: Bookmarks, id: string, line: number): Bookmarks {
  const had = marks[id] ?? [];
  const lines = had.includes(line)
    ? had.filter((l) => l !== line)
    : [...had, line].sort((a, b) => a - b);
  return withLines(marks, id, lines);
}

/**
 * The next mark below `line`, wrapping to the first. Wrapping is what makes
 * the key usable with one hand: three marks in a file become a rotation, not
 * a walk that dead-ends at the bottom.
 */
export function nextAfter(marks: Bookmarks, id: string, line: number): number | null {
  const lines = marks[id] ?? [];
  if (lines.length === 0) return null;
  return lines.find((l) => l > line) ?? lines[0];
}

/** The previous mark above `line`, wrapping to the last. */
export function prevBefore(marks: Bookmarks, id: string, line: number): number | null {
  const lines = marks[id] ?? [];
  if (lines.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] < line) return lines[i];
  return lines[lines.length - 1];
}

/**
 * The file gained (or lost) `delta` lines at `from`. Marks below the change
 * move with the text; a mark inside lines that were removed goes, because
 * there is no line left for it to be on.
 */
export function shiftFrom(
  marks: Bookmarks,
  id: string,
  from: number,
  delta: number,
): Bookmarks {
  const lines = marks[id] ?? [];
  if (lines.length === 0 || delta === 0) return marks;
  const moved: number[] = [];
  for (const line of lines) {
    if (line < from) {
      moved.push(line);
      continue;
    }
    if (delta < 0 && line < from - delta) continue;
    moved.push(line + delta);
  }
  return withLines(marks, id, moved);
}

/** A closed tab takes its marks with it. */
export function dropDoc(marks: Bookmarks, id: string): Bookmarks {
  if (!(id in marks)) return marks;
  const left = { ...marks };
  delete left[id];
  return left;
}

/** A file with no marks left keeps no entry: this record is persisted. */
function withLines(marks: Bookmarks, id: string, lines: number[]): Bookmarks {
  if (lines.length === 0) return dropDoc(marks, id);
  return { ...marks, [id]: lines };
}

// ---------------------------------------------------------------------------
// the record on disk
// ---------------------------------------------------------------------------

/** Empty when there is nothing to say, so the kv keeps no key at all. */
export function serializeBookmarks(marks: Bookmarks): string {
  const keys = Object.keys(marks);
  if (keys.length === 0) return "";
  return JSON.stringify(marks);
}

/**
 * The other half. Everything here is validated rather than trusted: this
 * string comes off disk, it is read during the restore that also brings back
 * unsaved drafts, and a throw in that path costs the user real work.
 */
export function parseBookmarks(raw: string | undefined): Bookmarks {
  if (!raw) return NO_MARKS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return NO_MARKS;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return NO_MARKS;
  const out: Record<string, number[]> = {};
  for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const lines = [
      ...new Set(
        value.filter((l): l is number => Number.isInteger(l) && (l as number) >= 0),
      ),
    ].sort((a, b) => a - b);
    if (lines.length) out[id] = lines;
  }
  return out;
}
