/**
 * The runtime mirror's two pure predicates. `reachedWait` decides when a
 * `yard wait` returns, so a wrong answer here is either an orchestrator that
 * hangs until its timeout or one that acts on a turn that never happened.
 */
import { describe, expect, it } from "vitest";

import { isLive, reachedWait, type TerminalRuntime } from "./terminalsStore";

function runtime(patch: Partial<TerminalRuntime> = {}): TerminalRuntime {
  return {
    state: "running",
    pid: 1234,
    exit: null,
    error: null,
    unread: false,
    finished: false,
    finishedAt: 0,
    blocked: false,
    blockedAsk: null,
    rssMb: 0,
    cpu: 0,
    ...patch,
  };
}

const WORKING = runtime();
const DONE = runtime({ finished: true, unread: true });
const BLOCKED = runtime({
  finished: true,
  unread: true,
  blocked: true,
  blockedAsk: "Do you want to proceed?",
});
const DEAD = runtime({ state: "exited", pid: null });

describe("isLive", () => {
  it("counts running and starting, nothing else", () => {
    expect(isLive(WORKING)).toBe(true);
    expect(isLive(runtime({ state: "starting" }))).toBe(true);
    expect(isLive(DEAD)).toBe(false);
    expect(isLive(runtime({ state: "error" }))).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });
});

describe("reachedWait", () => {
  it("never resolves on an agent that is working", () => {
    for (const until of ["stopped", "done", "blocked"] as const) {
      expect(reachedWait(WORKING, until)).toBe(false);
    }
  });

  it("treats blocked and done as different stops", () => {
    expect(reachedWait(DONE, "done")).toBe(true);
    expect(reachedWait(DONE, "blocked")).toBe(false);
    expect(reachedWait(BLOCKED, "blocked")).toBe(true);
    // The one that would hang an orchestrator: an agent stopped at a question
    // has *not* finished the task, and `done` must not accept it.
    expect(reachedWait(BLOCKED, "done")).toBe(false);
  });

  it("accepts either stop for the default", () => {
    expect(reachedWait(DONE, "stopped")).toBe(true);
    expect(reachedWait(BLOCKED, "stopped")).toBe(true);
  });

  it("resolves for a process that went down, whatever was asked", () => {
    for (const until of ["stopped", "done", "blocked"] as const) {
      expect(reachedWait(DEAD, until)).toBe(true);
      expect(reachedWait(runtime({ state: "error" }), until)).toBe(true);
    }
  });

  it("says no for a terminal the mirror has never seen", () => {
    expect(reachedWait(undefined, "stopped")).toBe(false);
  });
});
