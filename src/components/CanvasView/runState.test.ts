/**
 * Every row of the flow HUD subscribed to a one-second clock, finished runs
 * included, so a board with a few old results re-rendered them every second
 * for a label that never changes. The row's state decides whether a clock is
 * needed at all: only a run still going shows elapsed time.
 */
import { describe, expect, it } from "vitest";

import { runState } from "./runState";

const run = (over: Partial<{ error: string | null; cancelled: boolean; finishedAt: number | null }> = {}) => ({
  startedAt: 1_000,
  error: null,
  cancelled: false,
  finishedAt: null,
  ...over,
});

describe("runState", () => {
  it("a run still going counts elapsed time from its start", () => {
    expect(runState(run())).toEqual({ kind: "running", since: 1_000 });
  });

  it("failed, cancelled and finished runs have a fixed label and nothing to tick", () => {
    expect(runState(run({ error: "boom", finishedAt: 2_000 })).kind).toBe("failed");
    expect(runState(run({ error: "boom" })).kind).toBe("failed");
    expect(runState(run({ cancelled: true })).kind).toBe("cancelled");
    expect(runState(run({ finishedAt: 2_000 })).kind).toBe("done");
  });
});
