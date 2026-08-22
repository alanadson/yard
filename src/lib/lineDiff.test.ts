import { describe, expect, it } from "vitest";

import { diffLines } from "./lineDiff";

const marksOf = (old: string, cur: string) => {
  const out = diffLines(old, cur);
  if (!out) throw new Error("diff gave up");
  return out;
};

describe("diffLines", () => {
  it("equal: nothing marked", () => {
    const { marks, deletions } = marksOf("a\nb\nc", "a\nb\nc");
    expect(marks.size).toBe(0);
    expect(deletions.size).toBe(0);
  });

  it("an inserted line becomes add on the new line", () => {
    const { marks, deletions } = marksOf("a\nc", "a\nb\nc");
    expect(marks.get(2)).toBe("add");
    expect(marks.size).toBe(1);
    expect(deletions.size).toBe(0);
  });

  it("a replaced line becomes mod", () => {
    const { marks } = marksOf("a\nb\nc", "a\nX\nc");
    expect(marks.get(2)).toBe("mod");
    expect(marks.size).toBe(1);
  });

  it("uneven replacement: the inserted surplus is add", () => {
    const { marks } = marksOf("a\nb\nc", "a\nX\nY\nZ\nc");
    expect(marks.get(2)).toBe("mod");
    // The remaining new lines of the block arrive as additions.
    expect([...marks.values()].filter((m) => m === "add").length).toBe(2);
  });

  it("a pure removal becomes a marker between lines", () => {
    const { marks, deletions } = marksOf("a\nb\nc", "a\nc");
    expect(marks.size).toBe(0);
    // The `b` vanished before line 2 of the new text ("c").
    expect(deletions.has(2)).toBe(true);
  });

  it("a removal at the end points past the last line", () => {
    const { deletions } = marksOf("a\nb", "a");
    expect(deletions.has(2)).toBe(true);
  });

  it("additions at the start and at the end", () => {
    const { marks } = marksOf("m", "a\nm\nz");
    expect(marks.get(1)).toBe("add");
    expect(marks.get(3)).toBe("add");
    expect(marks.size).toBe(2);
  });

  it("a whole new file is all add", () => {
    const { marks } = marksOf("", "a\nb");
    // The old text is one empty line; the diff matches what it can and marks the rest.
    expect(marks.size).toBeGreaterThanOrEqual(1);
    expect([...marks.values()].every((m) => m === "add" || m === "mod")).toBe(true);
  });

  it("distant changes do not contaminate each other", () => {
    const old = ["um", "dois", "tres", "quatro", "cinco", "seis"].join("\n");
    const cur = ["um", "DOIS", "tres", "quatro", "cinco", "SEIS"].join("\n");
    const { marks } = marksOf(old, cur);
    expect(marks.get(2)).toBe("mod");
    expect(marks.get(6)).toBe("mod");
    expect(marks.size).toBe(2);
  });

  it("gives up politely on a giant diff", () => {
    const old = Array.from({ length: 6000 }, (_, i) => `linha ${i}`).join("\n");
    const cur = Array.from({ length: 6000 }, (_, i) => `outra ${i * 7}`).join("\n");
    expect(diffLines(old, cur)).toBeNull();
  });
});
