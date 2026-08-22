import { describe, expect, it } from "vitest";

import { changedSpan } from "./diff";

describe("changedSpan", () => {
  it("finds only the piece that changed", () => {
    expect(changedSpan("um dois tres", "um DOIS tres")).toEqual({
      from: 3,
      to: 7,
      insert: "DOIS",
    });
  });

  it("a pure insertion deletes nothing", () => {
    expect(changedSpan("plano", "**plano**")).toEqual({
      from: 0,
      to: 5,
      insert: "**plano**",
    });
    expect(changedSpan("ab", "aXb")).toEqual({ from: 1, to: 1, insert: "X" });
  });

  it("a pure removal inserts nothing", () => {
    expect(changedSpan("aXb", "ab")).toEqual({ from: 1, to: 2, insert: "" });
  });

  it("identical text becomes an empty span", () => {
    expect(changedSpan("igual", "igual")).toEqual({ from: 5, to: 5, insert: "" });
  });

  it("applying the span rebuilds the target", () => {
    const pairs: [string, string][] = [
      ["- item", "- [ ] item"],
      ["# a\n# b", "# a\n\n# b"],
      ["", "novo"],
      ["some tudo", ""],
    ];
    for (const [a, b] of pairs) {
      const { from, to, insert } = changedSpan(a, b);
      expect(a.slice(0, from) + insert + a.slice(to)).toBe(b);
    }
  });
});
