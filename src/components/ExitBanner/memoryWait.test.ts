/**
 * The "waiting for free memory" strip exists for one state only: an agent
 * that is starting while the machine is below the backend's spawn mark. But
 * every mounted terminal (every tab, every card) subscribed to the free
 * memory itself, which the resources tick moves every two seconds, so each
 * tick re-rendered all of them to paint nothing. The strip now subscribes to
 * `memoryWaitMb`, which is constant (`null`) outside that state and inside it
 * changes only when the number it prints does.
 */
import { describe, expect, it } from "vitest";

import type { TerminalRow } from "../../lib/ipc";
import type { TerminalRuntime } from "../../stores/terminalsStore";
import { memoryWaitMb, SPAWN_MIN_FREE_MB } from "./memoryWait";

const starting = { state: "starting" } as Pick<TerminalRuntime, "state">;
const running = { state: "running" } as Pick<TerminalRuntime, "state">;
const agent = { kind: "agent" } as Pick<TerminalRow, "kind">;
const shell = { kind: "shell" } as Pick<TerminalRow, "kind">;

describe("memoryWaitMb: a value that only moves while the strip is on screen", () => {
  it("is the free memory, rounded as printed, for an agent starting below the mark", () => {
    expect(memoryWaitMb(starting, agent, 312.6)).toBe(313);
  });

  it("follows the tick while waiting, and only when the printed number changes", () => {
    expect(memoryWaitMb(starting, agent, 250.2)).toBe(memoryWaitMb(starting, agent, 249.9));
    expect(memoryWaitMb(starting, agent, 180)).not.toBe(memoryWaitMb(starting, agent, 250));
  });

  it("is null, whatever the memory, for a process that is not starting", () => {
    expect(memoryWaitMb(running, agent, 120)).toBeNull();
    expect(memoryWaitMb(running, agent, 350)).toBeNull();
    expect(memoryWaitMb(null, agent, 120)).toBeNull();
    expect(memoryWaitMb(undefined, agent, 120)).toBeNull();
  });

  it("is null for a shell: the backend only holds agents back for memory", () => {
    expect(memoryWaitMb(starting, shell, 120)).toBeNull();
    expect(memoryWaitMb(starting, undefined, 120)).toBeNull();
  });

  it("is null at or above the mark, and while the first tick has not told us anything", () => {
    expect(memoryWaitMb(starting, agent, SPAWN_MIN_FREE_MB)).toBeNull();
    expect(memoryWaitMb(starting, agent, 8_000)).toBeNull();
    expect(memoryWaitMb(starting, agent, 0)).toBeNull();
  });
});
