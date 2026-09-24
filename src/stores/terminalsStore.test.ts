/**
 * The runtime mirror's two pure predicates. `reachedWait` decides when a
 * `yard wait` returns, so a wrong answer here is either an orchestrator that
 * hangs until its timeout or one that acts on a turn that never happened.
 */
import { describe, expect, it } from "vitest";

import type { PtyResource } from "../lib/ipc";
import { isLive, reachedWait, useTerminals, type TerminalRuntime } from "./terminalsStore";

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
    permission: false,
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

describe("what a CLI's own hook tells the mirror", () => {
  it("a permission prompt is a block with its own flag, so the badge can say which", () => {
    useTerminals.setState({ byId: {} });
    useTerminals.getState().markRunning("t1", 42);
    useTerminals.getState().markPermission("t1", "Claude needs your permission to use Bash");
    const rt = useTerminals.getState().get("t1");
    expect(rt.blocked).toBe(true);
    expect(rt.permission).toBe(true);
    expect(rt.blockedAsk).toContain("Bash");
    expect(rt.finished).toBe(true);
  });

  it("the turn starting again lifts the block and the flag", () => {
    useTerminals.setState({ byId: {} });
    useTerminals.getState().markRunning("t1", 42);
    useTerminals.getState().markPermission("t1", "ask");
    useTerminals.getState().hookTurnStart("t1");
    const rt = useTerminals.getState().get("t1");
    expect(rt.blocked).toBe(false);
    expect(rt.permission).toBe(false);
    expect(rt.finished).toBe(false);
  });

  it("a tool running means the permission was granted; the plain silence block stays a block", () => {
    useTerminals.setState({ byId: {} });
    useTerminals.getState().markRunning("t1", 42);
    useTerminals.getState().markPermission("t1", "ask");
    useTerminals.getState().hookWorking("t1");
    expect(useTerminals.getState().get("t1").blocked).toBe(false);
    useTerminals.getState().markBlocked("t1", "(y/N)");
    expect(useTerminals.getState().get("t1").permission).toBe(false);
  });
});

/**
 * The resource tick lands every two seconds for every busy PTY, and a busy
 * process never reports the same float twice. A new entry in `byId` re-renders
 * its card, so the tick may only replace what a reader can actually see: the
 * per-terminal MB is printed whole (`toFixed(0)`, badge shown when `> 0`),
 * nothing paints `cpu`, the CLIs' total is printed whole too, and only the
 * machine's free/total memory is read at full precision (the meter's `scaleX`
 * and the spawn gate).
 */
describe("the resource tick", () => {
  const TOTALS = { totalRssMb: 120.2, availableMb: 8000, totalMb: 16000 };

  /** One PTY's line of the tick, as `resources://tick` carries it. */
  const reading = (rssMb: number, cpu: number): PtyResource => ({
    id: "t1",
    pids: [1234],
    rssMb,
    cpu,
  });

  function seed(rssMb: number, cpu = 3) {
    useTerminals.setState({
      byId: { t1: runtime({ rssMb, cpu }) },
      totalRssMb: TOTALS.totalRssMb,
      systemAvailableMb: TOTALS.availableMb,
      systemTotalMb: TOTALS.totalMb,
    });
  }

  it("keeps the same state when the change is below what the card prints", () => {
    seed(120.2);
    const before = useTerminals.getState();
    useTerminals.getState().applyResources([reading(120.4, 9.7)], TOTALS);
    expect(useTerminals.getState()).toBe(before);
  });

  it("replaces the terminal's entry when the printed MB moves", () => {
    seed(120.4);
    const before = useTerminals.getState().byId;
    useTerminals.getState().applyResources([reading(121.6, 3)], TOTALS);
    expect(useTerminals.getState().byId).not.toBe(before);
    expect(useTerminals.getState().byId.t1.rssMb).toBe(121.6);
  });

  it("shows the badge of a process that starts reporting memory, even under 1 MB", () => {
    seed(0);
    useTerminals.getState().applyResources([reading(0.3, 0)], TOTALS);
    expect(useTerminals.getState().byId.t1.rssMb).toBe(0.3);
  });

  it("ignores noise in the CLIs' total that the printed MB does not show", () => {
    seed(120.2);
    const before = useTerminals.getState();
    useTerminals.getState().applyResources([], { ...TOTALS, totalRssMb: 120.45 });
    expect(useTerminals.getState()).toBe(before);
  });

  it("follows every move of the free memory, which the meter draws at full precision", () => {
    seed(120.2);
    useTerminals.getState().applyResources([], { ...TOTALS, availableMb: 8000.5 });
    expect(useTerminals.getState().systemAvailableMb).toBe(8000.5);
  });
});

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
