/**
 * The attach half of a mounting terminal, as rules: what it asks
 * `attach_pty` for and what it does with the answer (`XTermView` runs the
 * effects). They live together because they have to agree: whatever the
 * request lets the backend leave out must be something the plan never reads.
 */
import type { AttachResult, AttachWants } from "../../lib/ipc";

/**
 * How much replayed scrollback the URL scanner reads on attach. A startup
 * banner is at the top of the session, but the ring buffer can be 4 MB. This
 * is the compromise: enough for a server that started recently, cheap enough
 * to run on every mount. In UTF-16 units, the way `String.slice` counts.
 */
export const SCAN_TAIL = 64 * 1024;

/**
 * What the view will use, given the one fact it knows before attaching:
 * `autoStart`. Alive or not, and on which screen, only the answer says, so
 * both uses are conditions, and each mirrors a branch of `replayPlan`:
 *
 * - dead with auto-start is `freshBoot`, which replays nothing and scans
 *   nothing. After a restart that is every terminal that was running, and
 *   each one used to read up to 4 MB from disk for this;
 * - a live alternate screen replays nothing (its frame comes from a
 *   repaint) and scans only `data.slice(-SCAN_TAIL)`.
 */
export function attachWants(autoStart: boolean): AttachWants {
  return { omitDeadHistory: autoStart, altTail: SCAN_TAIL };
}

export interface ReplayPlan {
  /** Dead and set to auto-start: the new process starts on a clean screen. */
  freshBoot: boolean;
  /** A live full-screen CLI: ask the console host for its frame. */
  askForFrame: boolean;
  /** What to write into xterm before the live output is let in ("" = nothing). */
  rebuild: string;
  /** The tail the URL scanner and the blocked detector read, or `null` for none. */
  scanTail: string | null;
}

/** What the view does with the answer to its attach. */
export function replayPlan(
  attached: Pick<AttachResult, "alive" | "altScreen" | "data">,
  autoStart: boolean,
): ReplayPlan {
  // Dead and with auto-start (app boot, respawn after exit): the new
  // process starts with a clean screen. Dead scrollback carries positioning
  // sequences recorded at a *different* screen size; replaying that
  // leaves blank lines at the top and the prompt in the middle of the pane.
  // Replay is for the cases where it's faithful: a live process (reload/HMR,
  // same buffer) and a manual "Resume" after suspend (no spawn until the click).
  const freshBoot = !attached.alive && autoStart;

  /**
   * A live full-screen CLI is asked for its screen; everything else has
   * its screen rebuilt from the log.
   *
   * The scrollback of an agent is not a history of *lines*, it is a
   * history of *edits* to one frame ("erase to end of line, cursor to
   * 50;3, three cells"), and every one of them assumes the frame that
   * preceded it, at the width it was drawn at. Replay that into a pane of
   * another size (which is exactly what leaving the canvas is) and almost
   * nothing lands: measured on a real session, 6 of 40 rows survive. The
   * pane goes black and the CLI never redraws it, because from its side
   * nothing happened.
   *
   * The console host, on the other hand, has the frame, and hands it over
   * on any size change. So: ask, don't guess.
   */
  const askForFrame = attached.alive && attached.altScreen;
  const rebuild = askForFrame
    ? // Land where the CLI thinks it is drawing. Without this the frame
      // arrives into the normal buffer and scrolls the pane instead of
      // painting it.
      "\x1b[?1049h"
    : attached.data && !freshBoot
      ? attached.data
      : "";

  // The scanner only sees what arrives while this view is mounted, and a
  // dev server announces itself once, at boot: very likely before anyone
  // opened the pane. The tail of the replayed scrollback closes that gap
  // (and the same gap for the blocked detector: an agent can sit at a prompt
  // for an hour, so the pane is very likely to be opened *after* the
  // question was asked).
  const scanTail = attached.alive && attached.data ? attached.data.slice(-SCAN_TAIL) : null;

  return { freshBoot, askForFrame, rebuild, scanTail };
}
