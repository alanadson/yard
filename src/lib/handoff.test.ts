/**
 * Why these rules matter: a handoff is the message that decides whether the
 * next agent repeats the last two hours or continues them. The failure modes
 * are both about *what is missing*: a summary with no state of the tree (the
 * new agent re-reads every file to find out what changed), and a summary that
 * is the whole transcript pasted in (the new agent spends its context window
 * on a log instead of on the work).
 *
 * There is no store, no IPC and no clock here — the caller brings the pieces,
 * this decides what the message says.
 */
import { describe, expect, it } from "vitest";

import { SAY_CAP, TURNS, handoffMessage } from "./handoff";
import type { Block } from "./transcript";

const say = (at: number, text: string): Block => ({ kind: "say", at, text });
const prompt = (at: number, text: string): Block => ({ kind: "prompt", at, text });

describe("handoffMessage", () => {
  const base = {
    from: "claude",
    role: "Refatorar o editor",
    branch: "yard/editor",
    files: 3,
    additions: 40,
    deletions: 12,
    blocks: [
      prompt(1, "refatore o editor"),
      say(2, "comecei pelo gitGutter"),
      say(3, "faltou o teste do rulers"),
    ] as Block[],
    left: "",
  };

  it("says who is handing over and what they were in charge of", () => {
    const text = handoffMessage(base);
    expect(text).toContain("claude");
    expect(text).toContain("Refatorar o editor");
  });

  it("carries the state of the tree, which is the part a transcript never has", () => {
    const text = handoffMessage(base);
    expect(text).toContain("yard/editor");
    expect(text).toContain("3");
    expect(text).toContain("+40");
    expect(text).toContain("−12");
  });

  it("ends with what the agent said last, because that is where the work stopped", () => {
    const text = handoffMessage(base);
    expect(text).toContain("faltou o teste do rulers");
  });

  /** A transcript pasted whole spends the next agent's context on a log. */
  it("keeps only the last few turns", () => {
    const many = Array.from({ length: 40 }, (_, i) => say(i, `turno ${i}`));
    const text = handoffMessage({ ...base, blocks: many });
    expect(text).toContain("turno 39");
    expect(text).not.toContain("turno 5");
    expect(TURNS).toBeLessThan(12);
  });

  it("cuts a single enormous turn instead of pasting a whole file into it", () => {
    const huge = say(1, "x".repeat(SAY_CAP + 500));
    const text = handoffMessage({ ...base, blocks: [huge] });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(SAY_CAP * 2);
  });

  it("leaves out the tool calls — the next agent will run its own", () => {
    const text = handoffMessage({
      ...base,
      blocks: [
        { kind: "tools", at: 1, items: [{ tool: "Edit", path: "a.ts", ok: true }] },
        say(2, "pronto"),
      ],
    });
    expect(text).not.toContain("Edit");
    expect(text).toContain("pronto");
  });

  it("says plainly when the tree is clean, instead of showing zeros", () => {
    const text = handoffMessage({ ...base, files: 0, additions: 0, deletions: 0 });
    expect(text).not.toContain("+0");
  });

  it("puts what is left at the top, when the user said what it is", () => {
    const text = handoffMessage({ ...base, left: "falta o teste do rulers" });
    const leftAt = text.indexOf("falta o teste do rulers");
    const lastSaid = text.indexOf("comecei pelo gitGutter");
    expect(leftAt).toBeGreaterThan(-1);
    expect(leftAt).toBeLessThan(lastSaid);
  });

  it("still produces a usable message with no transcript at all", () => {
    const text = handoffMessage({ ...base, blocks: [] });
    expect(text).toContain("claude");
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
