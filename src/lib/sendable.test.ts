/**
 * The rule that decides whether a prompt may be pushed into a terminal.
 *
 * It is worth locking down because the cost of getting it wrong is not a
 * failed send: `injectPrompt` ends with Enter, so text delivered to a CLI
 * frozen on `(y/N)` becomes the answer to that question — and the diff review
 * erases the whole project's annotations once a send "worked".
 */
import { beforeEach, describe, expect, it } from "vitest";

import { IDLE_MS, canSend, sendability } from "./sendable";
import { markActivity, useTerminals, type RunState } from "../stores/terminalsStore";
import { useProjects } from "../stores/projectsStore";
import type { TerminalRow } from "./ipc";

const NOW = 5_000_000;

function row(id: string): TerminalRow {
  return {
    id,
    groupId: "g1",
    slot: 0,
    title: "claude",
    kind: "agent",
    agentId: "claude",
    program: "claude.cmd",
    args: [],
    cwd: "C:\\proj",
    resume: null,
    sort: 0,
    alive: true,
    createdAt: 1,
  };
}

/** Puts one terminal in the store in a given runtime state. */
function stage(opts: {
  state: RunState;
  blocked?: boolean;
  blockedAsk?: string;
  lastByteAt?: number;
}) {
  useProjects.setState({ terminals: [row("t1")] });
  useTerminals.setState({
    byId: {
      t1: {
        state: opts.state,
        pid: 1,
        blocked: opts.blocked ?? false,
        blockedAsk: opts.blockedAsk,
      } as never,
    },
  });
  markActivity("t1", opts.lastByteAt ?? 0, 0);
}

describe("sendability", () => {
  beforeEach(() => {
    useProjects.setState({ terminals: [] });
    useTerminals.setState({ byId: {} });
  });

  it("a running, quiet terminal accepts", () => {
    stage({ state: "running", lastByteAt: NOW - IDLE_MS - 1 });
    expect(sendability("t1", NOW)).toEqual({ ok: true });
    expect(canSend("t1", NOW)).toBe(true);
  });

  it("no byte yet counts as idle at the prompt, not as busy", () => {
    stage({ state: "running", lastByteAt: 0 });
    expect(canSend("t1", NOW)).toBe(true);
  });

  it("writing right now is refused — the prompt would arrive broken", () => {
    stage({ state: "running", lastByteAt: NOW - 200 });
    const r = sendability("t1", NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("busy");
    expect(r.message).toContain("trabalhando");
  });

  /**
   * The case that motivated the module: stuck at a permission prompt, the
   * terminal has been silent for a long time, so the idle test alone would
   * call it ready — and it is precisely the worst possible destination.
   */
  it("stuck at a question is refused even after a long silence", () => {
    stage({
      state: "running",
      blocked: true,
      blockedAsk: "Apagar tudo? (y/N)",
      lastByteAt: NOW - 10 * 60_000,
    });
    const r = sendability("t1", NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("blocked");
    expect(r.message).toContain("Apagar tudo? (y/N)");
  });

  it("a dead process and a missing terminal have reasons of their own", () => {
    stage({ state: "exited" });
    expect(sendability("t1", NOW).reason).toBe("dead");
    expect(sendability("nao-existe", NOW).reason).toBe("missing");
  });
});
