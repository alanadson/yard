/**
 * The costs store is the one place that talks to the backend for the panel.
 * Two things go wrong in stores like this and never show on screen: a failed
 * read that silently empties a list the user was looking at, and a slow
 * answer for the old window landing after the fast one for the new window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usageHistory } = vi.hoisted(() => ({
  usageHistory: vi.fn(async (_days: number) => [] as unknown[]),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    usageHistory,
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
    writePref: vi.fn(async () => undefined),
  },
}));

import type { UsageRow } from "../lib/costs";
import { useCosts } from "./costsStore";
import { useUI } from "./uiStore";

function row(day: string, costUsd: number | null = 1): UsageRow {
  return {
    day,
    agent: "claude",
    projectPath: "C:\\p",
    model: "claude-opus-5",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd,
    sessions: 1,
  };
}

beforeEach(() => {
  usageHistory.mockReset();
  usageHistory.mockImplementation(async () => []);
  useCosts.setState({ days: 7, rows: [], loading: false, error: null, loadedAt: 0 });
  useUI.getState().closeModal();
});

describe("costsStore", () => {
  it("opens the panel and loads the rows of the current window", async () => {
    usageHistory.mockImplementation(async () => [row("2026-08-26")]);
    await useCosts.getState().open();
    expect(useUI.getState().modal).toBe("costs");
    expect(usageHistory).toHaveBeenCalledWith(7);
    expect(useCosts.getState().rows).toHaveLength(1);
    expect(useCosts.getState().loading).toBe(false);
    expect(useCosts.getState().loadedAt).toBeGreaterThan(0);
  });

  it("changing the window asks the backend for that many days", async () => {
    await useCosts.getState().setDays(30);
    expect(useCosts.getState().days).toBe(30);
    expect(usageHistory).toHaveBeenLastCalledWith(30);
  });

  it("a failed read keeps the rows on screen and says why", async () => {
    useCosts.setState({ rows: [row("2026-08-25")] });
    usageHistory.mockImplementation(async () => {
      throw new Error("disco fora");
    });
    await useCosts.getState().refresh();
    expect(useCosts.getState().rows).toHaveLength(1);
    expect(useCosts.getState().error).toContain("disco fora");
    expect(useCosts.getState().loading).toBe(false);
  });

  it("an answer for an old window never overwrites the newer one", async () => {
    let releaseSlow: (rows: UsageRow[]) => void = () => {};
    usageHistory.mockImplementationOnce(
      () => new Promise<UsageRow[]>((resolve) => (releaseSlow = resolve)),
    );
    usageHistory.mockImplementationOnce(async () => [row("2026-08-26", 9)]);
    const slow = useCosts.getState().setDays(30);
    const fast = useCosts.getState().setDays(1);
    await fast;
    releaseSlow([row("2026-08-01", 1)]);
    await slow;
    expect(useCosts.getState().days).toBe(1);
    expect(useCosts.getState().rows.map((r) => r.day)).toEqual(["2026-08-26"]);
    expect(useCosts.getState().loading).toBe(false);
  });
});
