/**
 * Keeping a front-end mirror of backend state fresh without a busy timer.
 *
 * The backend announces each change with an event. The mirror is read once
 * at start (a reloaded page must see the present before any event arrives),
 * on each visible announcement, when the window comes back on screen (events
 * the page could not act on are caught up in one read), and on a safety tick that
 * only runs while the window is shown: a minimized Yard asks nothing.
 *
 * Every dependency (the events, the window state, the timer) comes in as a
 * parameter, so the rule runs under test without Tauri or a real clock.
 */

/** The safety tick of a mirror the backend announces: events do the work. */
export const LIVE_FALLBACK_MS = 30_000;

export interface Visibility {
  get(): boolean;
  subscribe(listener: (shown: boolean) => void): () => void;
}

export interface LiveReadOptions {
  read: () => Promise<void>;
  /** Backend events that announce a change; each resolves to its unlisten. */
  events?: ReadonlyArray<(cb: () => void) => Promise<() => void>>;
  visibility: Visibility;
  /** Starts a repeating timer and returns its stop. */
  every: (tick: () => void, ms: number) => () => void;
  /** The safety tick, for an event lost on the way. */
  fallbackMs: number;
  onError?: (error: unknown) => void;
}

/** Starts keeping one mirror fresh; returns the stop. */
export function startLiveRead(options: LiveReadOptions): () => void {
  let stopped = false;
  let reading = false;
  /** A change was announced while a read was on its way. */
  let again = false;

  const run = (): void => {
    if (stopped || !options.visibility.get()) return;
    read();
  };

  const read = (): void => {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    again = false;
    void options
      .read()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        reading = false;
        if (again) run();
      });
  };

  const unlistens: (() => void)[] = [];
  for (const listen of options.events ?? []) {
    void listen(run).then((unlisten) => {
      if (stopped) unlisten();
      else unlistens.push(unlisten);
    }, (error) => options.onError?.(error));
  }

  // Nobody sees a hidden window: its safety tick lapses, and the return reads
  // once for everything that happened meanwhile.
  const stopTick = options.every(() => {
    if (options.visibility.get()) run();
  }, options.fallbackMs);
  const stopVisibility = options.visibility.subscribe((shown) => {
    if (shown) run();
  });

  read();
  return () => {
    stopped = true;
    stopTick();
    stopVisibility();
    for (const unlisten of unlistens.splice(0)) unlisten();
  };
}
