/**
 * Line diff between two texts — what feeds the editor's git gutter.
 *
 * The unified-diff parser in `diff.ts` reads what *git* computed; this one
 * computes the diff itself, because the gutter compares the **buffer** (which
 * includes what was typed and never saved) against HEAD — a pair git never
 * sees. Myers' O(ND) on interned lines, with a budget: past it the answer is
 * `null` and the gutter simply does not paint, which beats freezing a
 * keystroke on a 50k-line file.
 */

export interface LineChanges {
  /** 1-based line number in the new text → how it stands against the old one. */
  marks: Map<number, "add" | "mod">;
  /**
   * 1-based new-text line numbers **before which** old lines were deleted with
   * nothing in their place (`lines + 1` = deleted at the very end). Only pure
   * deletions land here — a delete paired with an insert is a `mod` above.
   */
  deletions: Set<number>;
}

/** Edit budget (the D in O(ND)). Past this the diff gives up — see above. */
const MAX_EDITS = 2000;
/** Interning is O(N) too; past this the file is not something a gutter helps. */
const MAX_LINES = 100_000;

/** Interns each line as a number so the diff compares integers, not strings. */
function intern(a: string[], b: string[]): { ha: number[]; hb: number[] } {
  const ids = new Map<string, number>();
  const take = (s: string): number => {
    let id = ids.get(s);
    if (id === undefined) {
      id = ids.size;
      ids.set(s, id);
    }
    return id;
  };
  return { ha: a.map(take), hb: b.map(take) };
}

/**
 * Myers' greedy shortest edit script (the classic formulation: one `V` per
 * depth, cloned into `trace` for the backtrack). Returns `null` when the two
 * sides differ by more than `MAX_EDITS` line edits.
 */
function shortestEdit(a: number[], b: number[]): Int32Array[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  // The seed that lets d=0, k=0 read "came from k+1" without a special case.
  if (1 + offset < v.length) v[1 + offset] = 0;
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return null;
}

/** Walks the trace back into "which old lines died, which new lines arrived". */
function backtrack(
  trace: Int32Array[],
  a: number[],
  b: number[],
): { dels: Set<number>; adds: Set<number> } { // i18n-ok
  const n = a.length;
  const m = b.length;
  const offset = Math.min(n + m, MAX_EDITS);
  const dels = new Set<number>();
  const adds = new Set<number>();
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        adds.add(prevY); // a downward move: b[prevY] was inserted
      } else {
        dels.add(prevX); // a rightward move: a[prevX] was deleted
      }
    }
    x = prevX;
    y = prevY;
  }
  return { dels, adds };
}

/**
 * The gutter's answer: how each line of `newText` stands against `oldText`.
 * `null` = the diff gave up (too many changes) and the gutter stays clean.
 */
export function diffLines(oldText: string, newText: string): LineChanges | null {
  const marks = new Map<number, "add" | "mod">();
  const deletions = new Set<number>();
  if (oldText === newText) return { marks, deletions };

  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;

  // Common head/tail off first: the O(ND) then runs on the changed middle
  // only, which is what makes recomputing on a debounce affordable.
  let head = 0;
  const maxHead = Math.min(a.length, b.length);
  while (head < maxHead && a[head] === b[head]) head++;
  let tail = 0;
  const maxTail = Math.min(a.length, b.length) - head;
  while (tail < maxTail && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const ca = a.slice(head, a.length - tail);
  const cb = b.slice(head, b.length - tail);
  const { ha, hb } = intern(ca, cb);
  const trace = shortestEdit(ha, hb);
  if (!trace) return null;
  const { dels, adds } = backtrack(trace, ha, hb);

  // Two pointers over the middle: a run of deletions meeting a run of
  // insertions is a *modification* while they overlap — the same pairing the
  // side-by-side diff viewer draws — and only the surplus stays add/delete.
  let i = 0;
  let j = 0;
  while (i < ca.length || j < cb.length) {
    let delRun = 0;
    while (i < ca.length && dels.has(i)) {
      i++;
      delRun++;
    }
    const insStart = j;
    let insRun = 0;
    while (j < cb.length && adds.has(j)) {
      j++;
      insRun++;
    }
    if (delRun === 0 && insRun === 0) {
      // A kept line on both sides — the alignment a valid script guarantees.
      i++;
      j++;
      continue;
    }
    const paired = Math.min(delRun, insRun);
    for (let t = 0; t < insRun; t++) {
      marks.set(head + insStart + t + 1, t < paired ? "mod" : "add");
    }
    if (insRun === 0) deletions.add(head + j + 1);
  }
  return { marks, deletions };
}
