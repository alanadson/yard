/**
 * A session read from the start, as a document. The events are the tail's
 * (`agents/tail.rs`); this turns them into blocks a person reads — prompt,
 * answer, the tools between them grouped, the result glued to its call — and
 * finds text in them without caring about accents, the way the rest of the
 * app searches.
 */
import { describe, expect, it } from "vitest";

import type { FeedEvent } from "./ipc";
import {
  searchTranscript,
  transcriptBlocks,
  transcriptMarkdown,
  transcriptTitle,
} from "./transcript";

const prompt = (text: string, at = 1): FeedEvent => ({ kind: "prompt", at, text });
const say = (text: string, at = 2): FeedEvent => ({ kind: "say", at, text });
const tool = (
  op: FeedEvent["op"],
  toolId: string,
  extra: Partial<FeedEvent> = {},
  at = 3,
): FeedEvent => ({ kind: "tool", at, toolId, tool: op, op, ...extra });

describe("transcriptBlocks", () => {
  it("a prompt, the answer and a tool call become blocks in order; usage is skipped", () => {
    const blocks = transcriptBlocks([
      prompt("arruma o login"),
      { kind: "usage", at: 1, inTokens: 1, outTokens: 1 },
      tool("read", "t1", { path: "src/login.ts" }),
      say("pronto"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["prompt", "tools", "say"]);
  });

  it("consecutive tool calls form one block and each result is glued to its call by id", () => {
    const blocks = transcriptBlocks([
      tool("edit", "t1", { path: "src/a.ts", added: 2, removed: 1 }),
      tool("run", "t2", { detail: "npm test" }),
      { kind: "result", at: 4, toolId: "t2", ok: false, text: "3 failed" },
      { kind: "result", at: 4, toolId: "ghost", ok: true },
      { kind: "result", at: 5, toolId: "t1", ok: true },
      say("corrigi"),
    ]);
    expect(blocks).toHaveLength(2);
    const tools = blocks[0];
    if (tools.kind !== "tools") throw new Error("expected a tools block");
    expect(tools.items.map((i) => i.ok)).toEqual([true, false]);
    expect(tools.items[1].result).toBe("3 failed");
    expect(tools.items[0]).toMatchObject({ path: "src/a.ts", added: 2, removed: 1 });
  });

  it("thinking stays a block of its own, so the view can fold it", () => {
    const blocks = transcriptBlocks([
      { kind: "think", at: 1, text: "hmm" },
      say("resposta"),
      { kind: "notify", at: 3, text: "sub-agent terminou" },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["think", "say", "notify"]);
  });
});

describe("searchTranscript", () => {
  const blocks = transcriptBlocks([
    prompt("Conserta a função de login"),
    tool("edit", "t1", { path: "src/Autenticação.ts" }),
    say("a funcao está corrigida"),
  ]);

  it("is accent-insensitive and returns the indexes of the blocks that match", () => {
    expect(searchTranscript(blocks, "funcao")).toEqual([0, 2]);
    expect(searchTranscript(blocks, "FUNÇÃO")).toEqual([0, 2]);
  });

  it("looks inside tool paths and details too", () => {
    expect(searchTranscript(blocks, "autenticacao")).toEqual([1]);
  });

  it("an empty or blank query matches nothing", () => {
    expect(searchTranscript(blocks, "")).toEqual([]);
    expect(searchTranscript(blocks, "   ")).toEqual([]);
  });
});

describe("transcriptTitle", () => {
  it("prefers the session's title, then the short id", () => {
    expect(transcriptTitle({ title: "Login quebrado", externalId: "abcdef123456" })).toBe(
      "Login quebrado",
    );
    expect(transcriptTitle({ title: null, externalId: "abcdef123456" })).toBe("sessão abcdef12");
  });
});

describe("transcriptMarkdown", () => {
  it("writes prompts as quotes, answers as text and tools as a list", () => {
    const md = transcriptMarkdown(
      transcriptBlocks([
        prompt("arruma o login"),
        tool("edit", "t1", { path: "src/a.ts" }),
        { kind: "result", at: 4, toolId: "t1", ok: true },
        say("pronto"),
      ]),
      "Login",
    );
    expect(md.startsWith("# Login\n")).toBe(true);
    expect(md).toContain("> arruma o login");
    expect(md).toContain("- edit `src/a.ts` ✓");
    expect(md).toContain("\npronto\n");
  });
});
