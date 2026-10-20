/**
 * Hands over only the latest of a burst of values, once per window.
 *
 * Built for the editors' text: a keystroke used to publish the whole
 * document to the store. The scheduler comes in as a parameter (a timer in
 * the app, a hand-driven one under test), and `flush` publishes at once for
 * the moments that cannot wait: a save, a blur, a shortcut, a file switch.
 */
export interface Coalescer<T> {
  push(value: T): void;
  /** Publishes the pending value now, if there is one. */
  flush(): void;
}

/** How long typed text may wait before the store hears about it. */
export const TEXT_PUBLISH_MS = 120;

export function createCoalescer<T>(
  publish: (value: T) => void,
  schedule: (run: () => void) => () => void,
): Coalescer<T> {
  let pending: { value: T } | null = null;
  let cancel: (() => void) | null = null;
  const flush = () => {
    cancel?.();
    cancel = null;
    const due = pending;
    pending = null;
    if (due) publish(due.value);
  };
  return {
    push(value) {
      pending = { value };
      if (!cancel) cancel = schedule(flush);
    },
    flush,
  };
}

/** The app's scheduler for typed text: a plain timer. */
export function textTimer(run: () => void): () => void {
  const timer = setTimeout(run, TEXT_PUBLISH_MS);
  return () => clearTimeout(timer);
}
