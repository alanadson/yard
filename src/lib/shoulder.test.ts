/**
 * The "Ombro" digest answers "what did this agent do while I was not
 * looking?" from the session's events. The numbers here are the ones the
 * overlay already computes (files, plan, usage) plus the few a summary needs
 * (turns, last message, commands, failures) — if the digest said "5 files"
 * and Ao Vivo said "4", one of them would be lying, so both go through the
 * same reducer.
 */
import { describe, expect, it } from "vitest";

import type { FeedEvent } from "./ipc";
import { digest, digestLine } from "./shoulder";

const prompt = (text: string, at = 1): FeedEvent => ({ kind: "prompt", at, text });
const say = (text: string, at = 2): FeedEvent => ({ kind: "say", at, text });
const think = (text: string, at = 2): FeedEvent => ({ kind: "think", at, text });
const tool = (
  op: FeedEvent["op"],
  extra: Partial<FeedEvent> = {},
  at = 3,
): FeedEvent => ({ kind: "tool", at, tool: op, op, ...extra });
const result = (toolId: string, ok: boolean, at = 4): FeedEvent => ({
  kind: "result",
  at,
  toolId,
  ok,
});

describe("digest", () => {
  it("counts turns as the user's prompts and keeps the last one", () => {
    const d = digest([prompt("arruma o login"), say("ok"), prompt("agora os testes", 5)]);
    expect(d.turns).toBe(2);
    expect(d.lastPrompt).toBe("agora os testes");
    expect(d.lastAt).toBe(5);
  });

  it("the last message is the first line of the last assistant text, trimmed — thinking does not count", () => {
    const d = digest([
      say("primeira resposta"),
      say("  ok, testes verdes\ndetalhes abaixo\n", 3),
      think("hmm, será?", 4),
    ]);
    expect(d.lastSay).toBe("ok, testes verdes");
  });

  it("files are sorted by touches, with edits, writes and reads told apart", () => {
    const d = digest([
      tool("read", { path: "src/a.ts" }),
      tool("edit", { path: "src/b.ts", added: 2, removed: 1 }),
      tool("edit", { path: "src/b.ts", added: 1, removed: 0 }),
      tool("write", { path: "src/c.ts" }),
      tool("read", { path: "src/b.ts" }),
    ]);
    expect(d.files.map((f) => f.path)).toEqual(["src/b.ts", "src/a.ts", "src/c.ts"]);
    expect(d.files[0]).toMatchObject({ edits: 2, writes: 0, reads: 1 });
  });

  it("commands, sub-agents and failed tool calls are counted", () => {
    const d = digest([
      tool("run", { toolId: "r1", detail: "npm test" }),
      result("r1", false),
      tool("run", { toolId: "r2", detail: "npm test" }),
      result("r2", true),
      tool("agent", { toolId: "a1", agentType: "Explore" }),
      result("a1", true),
    ]);
    expect(d.commands).toBe(2);
    expect(d.agents).toBe(1);
    expect(d.failures).toBe(1);
  });

  it("plan progress comes from the last todo list, and is absent without a plan", () => {
    const withPlan = digest([
      tool("todo", {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "pending" },
        ],
      }),
    ]);
    expect(withPlan.plan).toEqual({ done: 1, total: 3 });
    expect(digest([prompt("oi")]).plan).toBeNull();
  });

  it("usage is null until the first usage event, then carries the last totals", () => {
    expect(digest([prompt("oi")]).usage).toBeNull();
    const d = digest([
      { kind: "usage", at: 1, model: "claude-opus-5", inTokens: 10, outTokens: 5, costUsd: 0.1 },
      { kind: "usage", at: 2, inTokens: 30, outTokens: 12, costUsd: 0.4 },
    ]);
    expect(d.usage).toMatchObject({ model: "claude-opus-5", inTokens: 30, outTokens: 12, costUsd: 0.4 });
  });
});

describe("digestLine", () => {
  it("reads as one sentence, with the plurals right", () => {
    const d = digest([
      prompt("a"),
      tool("edit", { path: "src/x.ts" }),
      say("ok, testes verdes\nmais"),
    ]);
    expect(digestLine(d)).toBe("1 turno · 1 arquivo · último: “ok, testes verdes”");
    const many = digest([
      prompt("a"),
      prompt("b"),
      tool("edit", { path: "src/x.ts" }),
      tool("edit", { path: "src/y.ts" }),
    ]);
    expect(digestLine(many)).toBe("2 turnos · 2 arquivos");
  });

  it("says so when the session has nothing yet", () => {
    expect(digestLine(digest([]))).toBe("sem turnos ainda");
  });
});
