/**
 * The usage nudge reaches the backend (`usage_refresh`) only for the provider
 * that may have moved, at most once a minute each, and never for a hidden
 * window: the rule lives in `lib/usageNudge.ts`, this checks the store sends
 * what it decides.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ refresh: vi.fn((_provider?: string) => Promise.resolve()) }));
vi.mock("../lib/ipc", () => ({ ipc: { usageRefresh: api.refresh } }));

import { useUsage } from "./usageStore";

beforeEach(() => api.refresh.mockClear());

describe("useUsage.nudge", () => {
  it("asks the backend for the provider that went idle, once per minute", () => {
    useUsage.getState().nudge("codex", 1_000_000, true);
    useUsage.getState().nudge("codex", 1_010_000, true);
    expect(api.refresh.mock.calls).toEqual([["codex"]]);
  });

  it("asks nothing while the window is hidden", () => {
    useUsage.getState().nudge("grok", 2_000_000, false);
    expect(api.refresh).not.toHaveBeenCalled();
  });
});

/**
 * The regression this locks: the chip's refresh button went through the same
 * one-minute gate as the automatic nudges, so a click right after an agent
 * went idle did nothing at all. A click is the user asking; only a short
 * anti-double-click floor applies (the backend keeps its own 429 backoff).
 */
describe("useUsage.refreshNow", () => {
  it("reaches the backend even right after an automatic nudge", () => {
    useUsage.getState().nudge(undefined, 3_000_000, true);
    useUsage.getState().refreshNow(3_001_000);
    expect(api.refresh).toHaveBeenCalledTimes(2);
    // No provider named: the click refreshes every one of them.
    expect(api.refresh.mock.calls[1][0]).toBeUndefined();
  });

  it("ignores a second click within five seconds", () => {
    useUsage.getState().refreshNow(4_000_000);
    useUsage.getState().refreshNow(4_004_999);
    useUsage.getState().refreshNow(4_005_000);
    expect(api.refresh).toHaveBeenCalledTimes(2);
  });
});
