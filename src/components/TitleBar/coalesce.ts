/**
 * Folds a burst of calls into at most one per window, leading and trailing.
 *
 * Made for the title bar's `isMaximized` question: a drag on the window's
 * edge fires a resize event per mouse move, and each one used to be an IPC
 * round trip for an answer that does not change mid-drag. The two edges are
 * what keep the maximize glyph as responsive and as right as before:
 *
 * - **leading**: a lone call runs at once. A click on maximize, a snap, a
 *   double click on the bar: one resize, answered with no added delay.
 * - **trailing**: a call that lands while a window is open is not dropped, it
 *   runs when the window closes. The last resize of a drag is therefore
 *   always followed by a run, so the final state is the one painted, and no
 *   call waits longer than one window.
 *
 * The clock is a parameter (`Timer`) so the rule is tested with a manual one.
 */
export interface Timer {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The real clock, for the app; the tests bring a manual one. */
export const browserTimer: Timer = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Coalesced {
  /** Something happened: run now, or once the current window closes. */
  poke(): void;
  /** Cancel a pending run and ignore every later poke (the owner unmounted). */
  dispose(): void;
}

export function coalesce(run: () => void, windowMs: number, timer: Timer): Coalesced {
  /** The open window's timer, or `null` while quiet. */
  let openWindow: unknown = null;
  let pending = false;
  let disposed = false;

  const close = () => {
    openWindow = null;
    if (!pending || disposed) return;
    pending = false;
    run();
    // The trailing run opens a window of its own: a drag still going on is
    // answered once per window, not once per window plus once per event.
    openWindow = timer.set(close, windowMs);
  };

  return {
    poke() {
      if (disposed) return;
      if (openWindow !== null) {
        pending = true;
        return;
      }
      run();
      openWindow = timer.set(close, windowMs);
    },
    dispose() {
      disposed = true;
      pending = false;
      if (openWindow !== null) timer.clear(openWindow);
      openWindow = null;
    },
  };
}
