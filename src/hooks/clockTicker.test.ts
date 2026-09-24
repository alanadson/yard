// A shared clock only runs while somebody is listening and keeps stable subscription functions.
import { expect, it, vi } from "vitest";
import { createTicker } from "./clockTicker";

it("updates subscribed clocks and stops ticking after the final unsubscribe", async () => {
  vi.useFakeTimers();
  try {
    let now = 10;
    const ticker = createTicker(100, () => now);
    const seen: number[] = [];
    const stop = ticker.subscribe(() => seen.push(ticker.read()));
    now = 20;
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([20]);
    stop();
    now = 30;
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([20]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
