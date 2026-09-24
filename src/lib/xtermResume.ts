/**
 * Resumes a terminal's renderer now, inside the frame that reveals it.
 *
 * xterm 5.5 stops painting a terminal that is out of the viewport, and the
 * only thing that starts it again is an IntersectionObserver. The observer
 * reports the way back after the reveal frame has been painted, so a tab that
 * was hidden out of the viewport shows the screen it left with for a frame or
 * two before the output it got while away. Calling the observer's own handler
 * at the commit that reveals the tab unpauses the renderer at once and paints
 * the full screen before the first frame; the real callback that follows
 * finds nothing left to do.
 *
 * The handler is private, so it is looked up, not assumed: if a future xterm
 * drops it, this does nothing (and `xtermResume.test.ts` fails on the bundle,
 * which is how the upgrade finds out the stale frame is back).
 */

interface IntersectionHook {
  _handleIntersectionChange: (entry: { isIntersecting: boolean; intersectionRatio: number }) => void;
}

export function resumeRenderer(term: unknown): void {
  const renderService = (term as { _core?: { _renderService?: Partial<IntersectionHook> } | null } | null)
    ?._core?._renderService;
  if (typeof renderService?._handleIntersectionChange !== "function") return;
  renderService._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });
}
