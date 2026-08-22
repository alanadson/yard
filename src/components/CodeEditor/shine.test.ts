import { describe, expect, it } from "vitest";

import { LANGUAGES } from "./languages";
import { shineLines, sliceChunks, type ShineChunk } from "./shine";

describe("shineLines", () => {
  it("returns one row of chunks per line of text, without losing a character", async () => {
    const ts = LANGUAGES.find((l) => l.key === "typescript")!;
    const support = (await ts.load!())!;
    const theText = "const a = 1;\n// comentário\nlet b = \"oi\";";
    const lines = shineLines(theText, support);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.map((c) => c.text).join("")).join("\n")).toBe(theText);
  });

  it("paints what the grammar knows", async () => {
    const ts = LANGUAGES.find((l) => l.key === "typescript")!;
    const support = (await ts.load!())!;
    const [linha1, linha2] = shineLines("const a = 1;\n// oi", support);
    expect(linha1.some((c) => c.cls?.includes("tok-keyword"))).toBe(true);
    expect(linha1.some((c) => c.cls?.includes("tok-number"))).toBe(true);
    expect(linha2.some((c) => c.cls?.includes("tok-comment"))).toBe(true);
  });

  it("colors across lines — a block comment does not forget where it started", async () => {
    const c = LANGUAGES.find((l) => l.key === "c")!;
    const support = (await c.load!())!;
    const lines = shineLines("/* abre\nmeio\nfecha */", support);
    // The middle line has no comment marker of its own; only a whole-text
    // parse knows it is still inside the comment.
    expect(lines[1].some((chunk) => chunk.cls?.includes("tok-comment"))).toBe(true);
  });
});

describe("sliceChunks", () => {
  const chunks: ShineChunk[] = [
    { text: "const ", cls: "tok-keyword" },
    { text: "abc", cls: null },
  ];

  it("cuts in the middle of a chunk and keeps the class", () => {
    expect(sliceChunks(chunks, 2, 8)).toEqual([
      { text: "nst ", cls: "tok-keyword" },
      { text: "ab", cls: null },
    ]);
  });

  it("an empty cut returns nothing", () => {
    expect(sliceChunks(chunks, 4, 4)).toEqual([]);
  });

  it("the three slices of a highlight reassemble the line", () => {
    const inteira = (list: ShineChunk[]) => list.map((c) => c.text).join("");
    const before = sliceChunks(chunks, 0, 3);
    const middle = sliceChunks(chunks, 3, 7);
    const after = sliceChunks(chunks, 7, Infinity);
    expect(inteira(before) + inteira(middle) + inteira(after)).toBe("const abc");
  });
});
