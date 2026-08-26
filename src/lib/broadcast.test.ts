/**
 * Broadcast fans one terminal's keystrokes out to the rest of its group. The
 * target list is the whole safety of the feature: a wrong entry here types
 * into a CLI nobody meant to reach — another group's agent, a dead pane, or
 * the very terminal that produced the keystroke (which would double every
 * character).
 */
import { describe, expect, it } from "vitest";

import { broadcastLabel, broadcastTargets, toggleMessage } from "./broadcast";
import type { TerminalRow } from "./ipc";
import type { TerminalRuntime } from "../stores/terminalsStore";

function row(id: string, groupId: string, surface: "grid" | "canvas" = "grid"): TerminalRow {
  return {
    id,
    groupId,
    slot: 0,
    surface,
    title: id,
    kind: "agent",
    agentId: "claude",
    program: "claude",
    args: [],
    cwd: "C:\\proj",
    sort: 0,
    alive: true,
    createdAt: 1,
  };
}

function runtime(patch: Partial<TerminalRuntime> = {}): TerminalRuntime {
  return {
    state: "running",
    pid: 1,
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

const rows = [
  row("a", "g1"),
  row("b", "g1"),
  row("c", "g1", "canvas"),
  row("dead", "g1"),
  row("other", "g2"),
];

const runtimes: Record<string, TerminalRuntime> = {
  a: runtime(),
  b: runtime(),
  c: runtime({ state: "starting", pid: null }),
  dead: runtime({ state: "exited", pid: null }),
  other: runtime(),
};

describe("broadcastTargets", () => {
  it("reaches every other live terminal of the group, on both surfaces", () => {
    expect(broadcastTargets(rows, runtimes, "a", "g1")).toEqual(["b", "c"]);
  });

  it("never includes the source itself — that would double every keystroke", () => {
    expect(broadcastTargets(rows, runtimes, "b", "g1")).not.toContain("b");
  });

  it("skips terminals with no live process, and a terminal with no runtime at all", () => {
    const targets = broadcastTargets([...rows, row("ghost", "g1")], runtimes, "a", "g1");
    expect(targets).not.toContain("dead");
    expect(targets).not.toContain("ghost");
  });

  it("never crosses into another group", () => {
    expect(broadcastTargets(rows, runtimes, "a", "g1")).not.toContain("other");
    expect(broadcastTargets(rows, runtimes, "other", "g2")).toEqual([]);
  });
});

/**
 * The strip is the only thing that tells the user a keystroke is going to
 * several CLIs — it has to say how many, and it has to say when the answer is
 * "nobody" (a group whose other agents all exited), or the mode looks on for
 * no reason.
 */
describe("broadcastLabel", () => {
  it("counts the other live CLIs and names the key that turns it off", () => {
    expect(broadcastLabel(3)).toBe("⇶ Transmitindo para 3 CLIs · Ctrl+Shift+U desliga");
    expect(broadcastLabel(1)).toBe("⇶ Transmitindo para 1 CLI · Ctrl+Shift+U desliga");
  });

  it("says so when no other CLI in the group is alive", () => {
    expect(broadcastLabel(0)).toBe(
      "⇶ Transmitindo — nenhuma outra CLI viva no grupo · Ctrl+Shift+U desliga",
    );
  });
});

describe("toggleMessage", () => {
  it("tells what just happened, in the toast", () => {
    expect(toggleMessage(true, 2)).toBe("Transmitindo o teclado para 2 CLIs do grupo.");
    expect(toggleMessage(true, 1)).toBe("Transmitindo o teclado para 1 CLI do grupo.");
    expect(toggleMessage(true, 0)).toBe(
      "Transmissão ligada — nenhuma outra CLI viva no grupo por enquanto.",
    );
    expect(toggleMessage(false, 2)).toBe("Transmissão desligada.");
  });
});
