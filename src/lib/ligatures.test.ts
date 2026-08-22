import { describe, expect, it } from "vitest";

import { ligatureRanges } from "./ligatures";

/** Slices the input back out, which is what the renderer will draw joined. */
const joined = (text: string) =>
  ligatureRanges(text).map(([a, b]) => text.slice(a, b));

describe("ligatureRanges", () => {
  it("finds the everyday arrows and comparisons", () => {
    expect(joined("a => b -> c !== d")).toEqual(["=>", "->", "!=="]);
  });

  it("prefers the longest sequence at each position", () => {
    expect(joined("a === b")).toEqual(["==="]);
    expect(joined("x <= y <=> z")).toEqual(["<=", "<=>"]);
  });

  it("returns [start, end) pairs against the original string", () => {
    expect(ligatureRanges("ab=>cd")).toEqual([[2, 4]]);
  });

  it("joins nothing in plain prose", () => {
    expect(ligatureRanges("terminal comum, sem setas")).toEqual([]);
  });

  it("is reusable — the shared regex must not keep lastIndex", () => {
    expect(joined("=>")).toEqual(["=>"]);
    expect(joined("=>")).toEqual(["=>"]);
  });
});
