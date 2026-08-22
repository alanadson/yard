/**
 * A clock shared by every component that shows relative time.
 *
 * Two panels used to keep their own `setInterval` + `setState` at the top of
 * a long list, so a label going from "4s" to "9s" re-rendered up to 400 feed
 * rows — icons, path labels and all. One ticker per period, read through
 * `useSyncExternalStore`, lets the leaf that actually prints the number be
 * the only thing that re-renders.
 */
import { useSyncExternalStore } from "react";

interface Ticker {
  now: number;
  handle: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
}

const tickers = new Map<number, Ticker>();

function tickerFor(periodMs: number): Ticker {
  let t = tickers.get(periodMs);
  if (!t) {
    t = { now: Date.now(), handle: null, listeners: new Set() };
    tickers.set(periodMs, t);
  }
  return t;
}

/**
 * Current time, refreshed every `periodMs`.
 *
 * The value only changes on a tick, which is what keeps the snapshot stable
 * between renders — returning `Date.now()` directly would make
 * `useSyncExternalStore` loop.
 */
export function useNow(periodMs: number): number {
  const ticker = tickerFor(periodMs);
  return useSyncExternalStore(
    (onChange) => {
      ticker.listeners.add(onChange);
      if (!ticker.handle) {
        ticker.handle = setInterval(() => {
          ticker.now = Date.now();
          for (const fn of ticker.listeners) fn();
        }, periodMs);
      }
      return () => {
        ticker.listeners.delete(onChange);
        if (ticker.listeners.size === 0 && ticker.handle) {
          clearInterval(ticker.handle);
          ticker.handle = null;
        }
      };
    },
    () => ticker.now,
  );
}
