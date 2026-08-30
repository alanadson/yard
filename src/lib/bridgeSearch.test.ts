/**
 * Why these rules matter: `yard search` is how one agent finds what another
 * one printed, and what comes back goes straight into a terminal that a
 * language model is reading. Two failure modes are worth locking down: an
 * answer with no shape (the agent cannot tell which terminal said what) and
 * an answer with no ceiling (a one-word query pasting four thousand lines
 * into a context window).
 */
import { describe, expect, it } from "vitest";

import { formatSearch, parseSearch } from "./bridgeSearch";
import type { TerminalHits } from "./ipc";

describe("parseSearch", () => {
  it("takes the text as the positional argument", () => {
    expect(parseSearch(["erro de build"])).toEqual({
      text: "erro de build",
      all: false,
      limit: 4,
    });
  });

  it("joins loose words, because a shell splits an unquoted sentence", () => {
    expect(parseSearch(["erro", "de", "build"]).text).toBe("erro de build");
  });

  it("takes --all out of the group and into the whole workspace", () => {
    expect(parseSearch(["erro", "--all"]).all).toBe(true);
    // The flag is not part of what gets searched.
    expect(parseSearch(["erro", "--all"]).text).toBe("erro");
  });

  it("accepts a per-terminal limit and keeps it sane", () => {
    expect(parseSearch(["erro", "--limit", "10"]).limit).toBe(10);
    expect(parseSearch(["erro", "--limit", "0"]).limit).toBe(1);
    expect(parseSearch(["erro", "--limit", "999"]).limit).toBe(20);
  });

  it("has nothing to search when no text was given", () => {
    expect(parseSearch([]).text).toBe("");
    expect(parseSearch(["--all"]).text).toBe("");
  });
});

describe("formatSearch", () => {
  const answer: TerminalHits[] = [
    {
      terminalId: "t1",
      more: 0,
      hits: [
        { line: 12, col: 0, text: "erro: faltou o token", clipped: false },
        { line: 44, col: 0, text: "erro de novo", clipped: false },
      ],
    },
    {
      terminalId: "t2",
      more: 1,
      hits: [{ line: 3, col: 0, text: "erro no build", clipped: false }],
    },
  ];
  const nameOf = (id: string) => (id === "t1" ? "claude" : "codex");

  it("groups the lines under the terminal that said them", () => {
    const out = formatSearch(answer, nameOf, "erro");
    expect(out).toContain('"claude"');
    expect(out).toContain("  12: erro: faltou o token");
    expect(out).toContain("  44: erro de novo");
    expect(out).toContain('"codex"');
    expect(out).toContain("   3: erro no build");
  });

  it("says when a terminal had more to say than the limit allowed", () => {
    const out = formatSearch(answer, nameOf, "erro");
    expect(out).toContain("mais ocorrências");
  });

  /** An empty answer is information, and it is not an error. */
  it("says plainly that nothing was found", () => {
    const out = formatSearch([], nameOf, "abacaxi");
    expect(out).toContain("Nada encontrado");
    expect(out).toContain("abacaxi");
  });

  it("counts what it is handing over, so the reader knows the size", () => {
    expect(formatSearch(answer, nameOf, "erro")).toContain("3 linha");
  });

  it("ends with a newline — it is written into a terminal", () => {
    expect(formatSearch(answer, nameOf, "erro").endsWith("\n")).toBe(true);
    expect(formatSearch([], nameOf, "x").endsWith("\n")).toBe(true);
  });
});
