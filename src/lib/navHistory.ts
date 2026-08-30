/**
 * The editor's trail: where the reader has been, and how to get back.
 *
 * Every teleport the app already had, `Ctrl+P`, `F12`, a hit in the project
 * search, a `Ctrl+click` on a path the build printed, was one-way. This is
 * the return leg, and it is modelled on the browser because that is the model
 * every person already has in their hands: a trail behind, a trail ahead, and
 * a jump taken from the middle of the trail abandons the part ahead.
 *
 * The judgement call is what counts as travel. Walking down a function with
 * the arrow keys is reading, and recording it would turn "back" into "one
 * line up"; opening another file, or leaping across the one you are in, is
 * travel. That threshold is the whole of `isJump`.
 */

export interface NavSpot {
  /** The document's id (root + path), the editor's own key for a tab. */
  id: string;
  /** 0-based line, the scale the surface publishes the caret in. */
  line: number;
}

export interface NavHistory {
  /** Oldest first; the last entry is one step back. */
  back: NavSpot[];
  /** Nearest first; the first entry is one step forward. */
  forward: NavSpot[];
}

export const NO_HISTORY: NavHistory = { back: [], forward: [] };

/** How far the caret has to travel inside one file before it counts as a jump. */
export const JUMP_LINES = 10;

/** Places kept on each side. Past this the trail is archaeology, not navigation. */
export const NAV_CAP = 60;

function samePlace(a: NavSpot, b: NavSpot): boolean {
  return a.id === b.id && a.line === b.line;
}

/**
 * Did the caret *travel* from `from` to `to`? A different file always counts;
 * inside one file it takes more than a screenful.
 */
export function isJump(from: NavSpot | null, to: NavSpot): boolean {
  if (!from) return false;
  if (from.id !== to.id) return true;
  return Math.abs(from.line - to.line) >= JUMP_LINES;
}

/**
 * Leaves `from` on the trail. The part ahead goes: taking a new turn from the
 * middle of the history is a new branch, and keeping the old one would make
 * "forward" mean a road the reader never took.
 */
export function record(history: NavHistory, from: NavSpot): NavHistory {
  const top = history.back[history.back.length - 1];
  if (top && samePlace(top, from)) return { back: history.back, forward: [] };
  const back = [...history.back, from];
  return { back: back.slice(-NAV_CAP), forward: [] };
}

/** One step back, from `here`. `null` when there is no trail behind. */
export function goBack(
  history: NavHistory,
  here: NavSpot,
): { history: NavHistory; go: NavSpot } | null {
  const go = history.back[history.back.length - 1];
  if (!go) return null;
  return {
    go,
    history: {
      back: history.back.slice(0, -1),
      forward: [here, ...history.forward].slice(0, NAV_CAP),
    },
  };
}

/** One step forward, from `here`. `null` when nothing was left ahead. */
export function goForward(
  history: NavHistory,
  here: NavSpot,
): { history: NavHistory; go: NavSpot } | null {
  const go = history.forward[0];
  if (!go) return null;
  return {
    go,
    history: {
      back: [...history.back, here].slice(-NAV_CAP),
      forward: history.forward.slice(1),
    },
  };
}

/**
 * A closed tab leaves the trail. Landing on a document that is not open any
 * more reopens it from disk, which is exactly the place the reader was trying
 * to get back *from*.
 */
export function dropDoc(history: NavHistory, id: string): NavHistory {
  return {
    back: history.back.filter((spot) => spot.id !== id),
    forward: history.forward.filter((spot) => spot.id !== id),
  };
}

// ---------------------------------------------------------------------------
// the trail as one value
// ---------------------------------------------------------------------------

/**
 * Everything the store keeps. Bundling the current place with the two trails
 * is what leaves the store with no judgement of its own: it hands over where
 * the caret landed and gets the new trail back.
 */
export interface NavState {
  history: NavHistory;
  /** Where the caret is resting, what the next jump will leave behind. */
  here: NavSpot | null;
}

export const NO_NAV: NavState = { history: NO_HISTORY, here: null };

/**
 * The caret came to rest at `spot`. If getting there was travel, the place it
 * came *from* joins the trail: recording the destination instead would make
 * "back" return the reader to where they already are.
 */
export function arrive(nav: NavState, spot: NavSpot): NavState {
  if (!isJump(nav.here, spot)) return { history: nav.history, here: spot };
  return { history: record(nav.history, nav.here!), here: spot };
}

/** One step back. The arrival that follows is the step itself, not a new one. */
export function stepBack(nav: NavState): { nav: NavState; go: NavSpot } | null {
  if (!nav.here) return null;
  const step = goBack(nav.history, nav.here);
  if (!step) return null;
  return { go: step.go, nav: { history: step.history, here: step.go } };
}

/** One step forward, back down the branch the reader had walked. */
export function stepForward(nav: NavState): { nav: NavState; go: NavSpot } | null {
  if (!nav.here) return null;
  const step = goForward(nav.history, nav.here);
  if (!step) return null;
  return { go: step.go, nav: { history: step.history, here: step.go } };
}

/**
 * A tab closed. Its places leave both trails, and if the reader was standing
 * in it there is no current place any more, the next caret to land starts
 * the trail again rather than recording a file that is gone.
 */
export function forgetDoc(nav: NavState, id: string): NavState {
  return {
    history: dropDoc(nav.history, id),
    here: nav.here && nav.here.id === id ? null : nav.here,
  };
}
