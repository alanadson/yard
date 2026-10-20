/**
 * Every agent that went idle asked the backend to re-read the usage of every
 * provider, minimized window included, with only a 5 s floor: a board of
 * agents finishing turns kept three HTTP fetches going for a chip nobody was
 * looking at. A nudge now names the provider of the agent that stopped, waits
 * a minute between two of the same kind, and is not sent while the window is
 * hidden.
 */
import { describe, expect, it } from "vitest";

import { createNudgeGate, usageProviderOf, USAGE_NUDGE_FLOOR_MS } from "./usageNudge";

describe("usageProviderOf", () => {
  it("maps the agent that went idle to the provider whose usage it spends", () => {
    expect(usageProviderOf({ agentId: "claude", program: "claude.cmd" })).toBe("claude");
    expect(usageProviderOf({ agentId: null, program: "C:\\npm\\codex.cmd" })).toBe("codex");
    expect(usageProviderOf({ agentId: "grok", program: "grok" })).toBe("grok");
  });

  it("gives no provider for agents and shells whose usage Yard does not read", () => {
    expect(usageProviderOf({ agentId: "gemini", program: "gemini" })).toBeNull();
    expect(usageProviderOf({ agentId: null, program: "pwsh.exe" })).toBeNull();
    expect(usageProviderOf(undefined)).toBeNull();
  });
});

describe("createNudgeGate", () => {
  it("lets one nudge per provider through per minute", () => {
    const gate = createNudgeGate();
    expect(gate.take("claude", 1_000, true)).toBe(true);
    expect(gate.take("claude", 1_000 + USAGE_NUDGE_FLOOR_MS - 1, true)).toBe(false);
    expect(gate.take("claude", 1_000 + USAGE_NUDGE_FLOOR_MS, true)).toBe(true);
  });

  it("does not let a nudge for one provider hold back another", () => {
    const gate = createNudgeGate();
    expect(gate.take("claude", 1_000, true)).toBe(true);
    expect(gate.take("codex", 2_000, true)).toBe(true);
  });

  it("asks nothing while the window is hidden, and keeps the floor free for when it is back", () => {
    const gate = createNudgeGate();
    expect(gate.take("claude", 1_000, false)).toBe(false);
    expect(gate.take("claude", 2_000, true)).toBe(true);
  });

  it("counts a nudge for every provider as one for each of them", () => {
    const gate = createNudgeGate();
    expect(gate.take(undefined, 1_000, true)).toBe(true);
    expect(gate.take("codex", 2_000, true)).toBe(false);
    expect(gate.take(undefined, 3_000, true)).toBe(false);
    expect(gate.take("codex", 1_000 + USAGE_NUDGE_FLOOR_MS, true)).toBe(true);
  });
});
