/**
 * The front a card belongs to, and the colour it wears for it.
 *
 * A project canvas holds one front's cards, so the group's name says it all.
 * A board does not: it holds cards from any front of any project, and two
 * `claude` cards from two worktrees are indistinguishable without a badge.
 * The badge needs a colour that survives a reload without anybody choosing
 * one, which is what the hash is for; a chosen colour (`FloorMeta.color`)
 * wins when there is one.
 *
 * Pure: paths and fronts in, a front or a colour out.
 */

export interface FrontRef {
  /** The group's id: the front *is* a group. */
  id: string;
  name: string;
  /** The worktree (or the project root, for a ground). */
  worktreePath?: string;
  /** A colour the user picked; absent = the hash below. */
  color?: string;
}

/**
 * The hues a front may be born with: the board's own chroma steps, minus
 * the neutrals, which would read as "no front".
 */
export const FRONT_HUES = ["#5fa8ff", "#40d16e", "#f0c33c", "#c98bf2", "#ff6961", "#4ecdc4"] as const;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** The colour of a front: the one chosen, else one hashed from its id. */
export function frontColor(front: { id: string; color?: string }): string {
  if (front.color && front.color.trim()) return front.color.trim();
  return FRONT_HUES[hash(front.id) % FRONT_HUES.length];
}

function normalizePath(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  // A drive path is case-insensitive; a POSIX one is not.
  return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s;
}

/**
 * The front whose worktree holds `path`: the deepest one, so a card in a
 * front under `.yard/floors/` is not mistaken for the ground above it. A
 * sibling folder that merely shares a prefix (`yard-old` beside `yard`) does
 * not count: the separator is part of the test.
 */
export function frontOfPath(path: string, fronts: readonly FrontRef[]): FrontRef | null {
  const p = normalizePath(path);
  let best: FrontRef | null = null;
  let bestLen = -1;
  for (const f of fronts) {
    if (!f.worktreePath) continue;
    const root = normalizePath(f.worktreePath);
    if (!root) continue;
    if (p !== root && !p.startsWith(`${root}/`)) continue;
    if (root.length > bestLen) {
      best = f;
      bestLen = root.length;
    }
  }
  return best;
}

/**
 * What the card's badge should say, if anything.
 *
 * On a project canvas every card normally lives in the group's own front,
 * and a badge repeating the group's name on each card is noise; it appears
 * only on a card that runs somewhere else. On a board every card comes from
 * somewhere else, so every one that has a front says which.
 */
export function frontBadge(
  cardFront: FrontRef | null,
  groupFront: FrontRef | null,
  board: boolean,
): FrontRef | null {
  if (!cardFront) return null;
  if (board) return cardFront;
  return groupFront && groupFront.id === cardFront.id ? null : cardFront;
}
