/**
 * Lane assignment for the commit graph (§14.2, "Git Graph").
 *
 * `git log` gives a flat list; the shape of the history lives entirely in the
 * `parents` links. This turns one into the other: a column (lane) per line of
 * development, and per row the segments that have to be painted.
 *
 * The algorithm is the standard one and it is worth stating, because the
 * subtle part is not the assignment but the *carry*. At any row there is a set
 * of **open lanes**, each waiting for one specific hash. Drawing a row means:
 *
 * 1. find the lane already waiting for this commit — that is its lane. No lane
 *    waiting means nobody has referenced it yet: it is a tip, and it opens the
 *    leftmost free column;
 * 2. that lane now waits for the commit's **first** parent. First and not any,
 *    because a merge belongs to the branch it was made *on* — putting it on
 *    the incoming branch's lane draws a history that reads backwards;
 * 3. every other parent (a merge has more than one) goes to whichever lane is
 *    already waiting for it, or opens one;
 * 4. any other lane still open just **passes through** this row, and its
 *    vertical segment has to be painted or the branch appears to start out of
 *    nowhere a few rows later.
 *
 * Lanes are freed the moment nothing waits on them and reused from the left,
 * which is what stops a log with forty short branches from drifting forty
 * columns to the right.
 *
 * Nothing here reads git, a store or the DOM: it takes `{hash, parents}` and
 * returns numbers, which is why it can be tested exhaustively.
 */

/** The only two fields the layout needs from a commit. */
export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface GraphRow {
  hash: string;
  /** Column this commit's dot sits in. */
  lane: number;
  /**
   * Where this commit's own lines go down to: one entry per parent that is
   * present in this page. A root — or a commit whose parent fell off the end
   * of the page — has none.
   */
  links: number[];
  /**
   * Lanes that merely cross this row without touching it. Their segment is
   * a straight vertical line.
   */
  through: number[];
  /**
   * Lanes that end **at** this commit because it is their awaited parent —
   * the join, drawn as a line coming in from those columns. Excludes the
   * commit's own lane.
   */
  merges: number[];
}

export function layoutCommits(commits: readonly GraphCommit[]): GraphRow[] {
  /** Lane -> hash that lane is waiting for. `null` = the lane is free. */
  const waiting: (string | null)[] = [];

  const claim = (hash: string): number => {
    const existing = waiting.indexOf(hash);
    if (existing >= 0) return existing;
    const free = waiting.indexOf(null);
    if (free >= 0) {
      waiting[free] = hash;
      return free;
    }
    waiting.push(hash);
    return waiting.length - 1;
  };

  const rows: GraphRow[] = [];
  const present = new Set(commits.map((c) => c.hash));

  for (const commit of commits) {
    // Every lane expecting this commit converges here. The leftmost is the
    // one the dot sits in; the rest end at this row and are freed.
    const incoming: number[] = [];
    for (let i = 0; i < waiting.length; i++) {
      if (waiting[i] === commit.hash) incoming.push(i);
    }
    const lane = incoming.length ? incoming[0] : claim(commit.hash);
    for (const other of incoming.slice(1)) waiting[other] = null;

    // Lanes crossing this row untouched — computed before the parents move in,
    // or a parent that lands in a free column would be drawn as a pass-through.
    const through: number[] = [];
    for (let i = 0; i < waiting.length; i++) {
      if (i !== lane && waiting[i] !== null && !incoming.includes(i)) through.push(i);
    }

    // This lane stops waiting for the commit and starts waiting for its first
    // parent — the line continues straight down.
    const known = commit.parents.filter((p) => present.has(p));
    waiting[lane] = known[0] ?? null;

    const links: number[] = [];
    if (known.length) {
      links.push(lane);
      for (const parent of known.slice(1)) links.push(claim(parent));
    }

    // Trailing free lanes are not lanes: trimming keeps the width honest, so
    // a card can size its gutter from the widest row it actually draws.
    while (waiting.length && waiting[waiting.length - 1] === null) waiting.pop();

    rows.push({
      hash: commit.hash,
      lane,
      links,
      through,
      merges: incoming.slice(1),
    });
  }

  return rows;
}

/** The widest lane the layout uses — what the gutter has to be sized for. */
export function laneCount(rows: readonly GraphRow[]): number {
  let max = 0;
  for (const r of rows) {
    max = Math.max(max, r.lane, ...r.links, ...r.through, ...r.merges);
  }
  return rows.length ? max + 1 : 0;
}
