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

import { createTicker } from "./clockTicker";

const tickers = new Map<number, ReturnType<typeof createTicker>>();

export function useNow(periodMs: number): number {
  let ticker = tickers.get(periodMs);
  if (!ticker) {
    ticker = createTicker(periodMs, Date.now);
    tickers.set(periodMs, ticker);
  }
  return useSyncExternalStore(ticker.subscribe, ticker.read);
}
