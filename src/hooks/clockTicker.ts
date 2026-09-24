/** A stable external-store subscription shared by labels with the same cadence. */
export function createTicker(periodMs: number, clock: () => number) {
  let now = clock();
  let handle: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const read = () => now;
  const subscribe = (onChange: () => void) => {
    listeners.add(onChange);
    if (!handle) {
      handle = setInterval(() => {
        now = clock();
        for (const listener of listeners) listener();
      }, periodMs);
    }
    return () => {
      listeners.delete(onChange);
      if (!listeners.size && handle) {
        clearInterval(handle);
        handle = null;
      }
    };
  };
  return { read, subscribe };
}
