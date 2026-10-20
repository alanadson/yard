/**
 * The decision behind the keep-awake ("modo energético") switch: *when* is
 * the PC held awake.
 *
 * The subtle case is the agents mode. `finished` is a latch that focusing the
 * pane releases, so it alone cannot say "working" — the freshness guard on
 * the activity heartbeat is what keeps a focused-but-quiet REPL from holding
 * the PC awake all night. And the backend must only hear about *transitions*:
 * the reconciler runs on a clock, so an unchanged answer must not cross the
 * IPC five times a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ipc, type TerminalRow } from "../lib/ipc";
import { agentWorking, parseMode, startKeepAwake, usePower } from "./powerStore";
import { useProjects } from "./projectsStore";
import { markActivity, useTerminals } from "./terminalsStore";

function term(id: string, kind: "shell" | "agent"): TerminalRow {
  return {
    id,
    groupId: "g1",
    slot: 0,
    title: id,
    kind,
    agentId: kind === "agent" ? "claude" : null,
    program: kind === "agent" ? "claude" : "pwsh",
    args: [],
    cwd: "C:\\proj",
    sort: 0,
    alive: true,
    createdAt: 0,
  };
}

beforeEach(() => {
  useProjects.setState({ terminals: [] });
  useTerminals.setState({ byId: {} });
  usePower.setState({ mode: "off", engaged: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parseMode", () => {
  it("accepts the three modes and falls back to off", () => {
    expect(parseMode("always")).toBe("always");
    expect(parseMode("agents")).toBe("agents");
    expect(parseMode("off")).toBe("off");
    expect(parseMode(undefined)).toBe("off");
    expect(parseMode("lixo")).toBe("off");
  });
});

describe("agentWorking", () => {
  it("ignores plain shells, however busy", () => {
    useProjects.setState({ terminals: [term("sh", "shell")] });
    useTerminals.getState().markRunning("sh", 1);
    markActivity("sh", Date.now(), 0);
    expect(agentWorking()).toBe(false);
  });

  it("counts a live agent with fresh output", () => {
    useProjects.setState({ terminals: [term("ag", "agent")] });
    useTerminals.getState().markRunning("ag", 1);
    markActivity("ag", Date.now(), 0);
    expect(agentWorking()).toBe(true);
  });

  it("gives a just-spawned agent (no bytes yet) the benefit of the doubt", () => {
    useProjects.setState({ terminals: [term("novo", "agent")] });
    useTerminals.getState().markStarting("novo");
    expect(agentWorking()).toBe(true);
  });

  it("drops the agent when the idle latch closes the turn", () => {
    useProjects.setState({ terminals: [term("fim", "agent")] });
    useTerminals.getState().markRunning("fim", 1);
    markActivity("fim", Date.now(), 0);
    useTerminals.getState().markFinished("fim");
    expect(agentWorking()).toBe(false);
  });

  it("does not trust a latch reset by focus: stale output = not working", () => {
    useProjects.setState({ terminals: [term("quieto", "agent")] });
    useTerminals.getState().markRunning("quieto", 1);
    // Focused pane released `finished`, but the last byte is 3 min old.
    markActivity("quieto", Date.now() - 3 * 60_000, 3 * 60_000);
    expect(agentWorking()).toBe(false);
  });

  it("never counts a dead agent", () => {
    useProjects.setState({ terminals: [term("morto", "agent")] });
    useTerminals.getState().patch("morto", { state: "exited" });
    markActivity("morto", Date.now(), 0);
    expect(agentWorking()).toBe(false);
  });
});

describe("startKeepAwake", () => {
  it("crosses the IPC only on transitions and releases on cleanup", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(ipc, "setKeepAwake").mockResolvedValue();

    const stop = startKeepAwake();
    expect(spy).not.toHaveBeenCalled();

    usePower.getState().setMode("always");
    expect(spy).toHaveBeenLastCalledWith(true, true);
    expect(usePower.getState().engaged).toBe(true);

    // The clock re-evaluates, the answer is the same: no new call.
    const calls = spy.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    expect(spy.mock.calls.length).toBe(calls);

    stop();
    expect(spy).toHaveBeenLastCalledWith(false, false);
    expect(usePower.getState().engaged).toBe(false);
  });

  it("agents mode engages with a working agent and lets go when the turn ends", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(ipc, "setKeepAwake").mockResolvedValue();

    useProjects.setState({ terminals: [term("ag", "agent")] });
    useTerminals.getState().markRunning("ag", 1);
    markActivity("ag", Date.now(), 0);

    const stop = startKeepAwake();
    usePower.getState().setMode("agents");
    expect(usePower.getState().engaged).toBe(true);
    // An agent at work needs the PC awake, not the screen lit.
    expect(spy).toHaveBeenLastCalledWith(true, false);

    // The turn ends; the next tick of the clock notices and releases.
    useTerminals.getState().markFinished("ag");
    vi.advanceTimersByTime(5_000);
    expect(usePower.getState().engaged).toBe(false);
    expect(spy).toHaveBeenLastCalledWith(false, false);

    stop();
  });

  /**
   * The "always" mode holds the display on as well; "agents" only keeps the
   * PC from suspending, so the screen of a machine left working overnight
   * still turns off. Moving between the two with an agent working is a
   * transition the backend has to hear even though "awake" did not change.
   */
  it("keeps the display lit only in always mode, and says so when the mode moves", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(ipc, "setKeepAwake").mockResolvedValue();
    useProjects.setState({ terminals: [term("ag", "agent")] });
    useTerminals.getState().markRunning("ag", 1);
    markActivity("ag", Date.now(), 0);

    const stop = startKeepAwake();
    usePower.getState().setMode("always");
    expect(spy).toHaveBeenLastCalledWith(true, true);
    usePower.getState().setMode("agents");
    expect(spy).toHaveBeenLastCalledWith(true, false);

    stop();
  });

  /** A clock re-reading every terminal every 5 s for a mode that never asks. */
  it("runs its clock only in agents mode", () => {
    vi.useFakeTimers();
    vi.spyOn(ipc, "setKeepAwake").mockResolvedValue();

    const stop = startKeepAwake();
    expect(vi.getTimerCount()).toBe(0);
    usePower.getState().setMode("agents");
    expect(vi.getTimerCount()).toBe(1);
    usePower.getState().setMode("always");
    expect(vi.getTimerCount()).toBe(0);

    stop();
  });
});
