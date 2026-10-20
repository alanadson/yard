/**
 * The limits that keep agents from spending on their own: how many agents
 * they may raise in one project, that a worker does not raise more, how much
 * text one `yard ask` hands back into the caller's context (which the caller
 * pays to read), how large a prompt may travel inline, and how many asks of a
 * batch run at once. Each of these failed silently before: the bill was the
 * only place they showed up.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_CAP_PER_PROJECT,
  agentCapReply,
  askReplyChars,
  largePromptMessage,
  mapLimited,
  needsPromptFile,
  workerDepthReply,
} from "./bridgeGuards";

describe("agentCapReply", () => {
  it("lets an agent raise agents up to eight live ones per project, and refuses past it", () => {
    expect(AGENT_CAP_PER_PROJECT).toBe(8);
    expect(agentCapReply(7, 1)).toBeNull();
    const refused = agentCapReply(8, 1);
    expect(refused).toContain("8");
    expect(refused?.endsWith("\n")).toBe(true);
  });

  it("counts every agent a fan-out would raise at once", () => {
    expect(agentCapReply(6, 2)).toBeNull();
    expect(agentCapReply(6, 3)).not.toBeNull();
  });
});

describe("workerDepthReply", () => {
  it("refuses a worker raising more agents, and lets anyone else", () => {
    expect(workerDepthReply(false, "recruit")).toBeNull();
    const refused = workerDepthReply(true, "worker create");
    expect(refused).toContain("worker");
    expect(refused).toContain("worker create");
  });
});

describe("askReplyChars", () => {
  it("is 8000 by default, takes a smaller number, and never more than 30000", () => {
    expect(askReplyChars(undefined)).toBe(8_000);
    expect(askReplyChars(500)).toBe(500);
    expect(askReplyChars(99_999)).toBe(30_000);
    expect(askReplyChars(0)).toBe(8_000);
    expect(askReplyChars(-4)).toBe(8_000);
  });
});

describe("prompts too large to type", () => {
  it("are the ones past 32 KB of UTF-8", () => {
    expect(needsPromptFile("a".repeat(32 * 1024))).toBe(false);
    expect(needsPromptFile("a".repeat(32 * 1024 + 1))).toBe(true);
    // Accented text is counted in bytes, not characters.
    expect(needsPromptFile("é".repeat(16 * 1024 + 1))).toBe(true);
  });

  it("travel as a short message that names the file", () => {
    const message = largePromptMessage("C:/Yard/attachments/yard-ask-1.md", 40_000);
    expect(message).toContain("C:/Yard/attachments/yard-ask-1.md");
    expect(message.length).toBeLessThan(400);
  });
});

describe("mapLimited", () => {
  it("runs at most N at a time and keeps the results in input order", async () => {
    const gates: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const work = mapLimited([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return n * 10;
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    expect(gates).toHaveLength(2);
    while (gates.length) {
      gates.shift()!();
      await flush();
    }
    expect(await work).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});
