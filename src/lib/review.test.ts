/**
 * The review's contract with the agent: grouped by file, ordered by line,
 * and never broken by source code that contains Markdown.
 */
import { describe, expect, it } from "vitest";

import { anchorKey, formatReview, inlineCode, type ReviewComment } from "./review";

const comment = (patch: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1",
  projectId: "p",
  root: "C:\\proj",
  path: "src/a.ts",
  line: 10,
  onOld: false,
  code: "const x = 1;",
  body: "isso pode sair do laço",
  createdAt: 1,
  ...patch,
});

describe("inlineCode", () => {
  it("wraps a plain snippet in single backticks", () => {
    expect(inlineCode("const x = 1;")).toBe("`const x = 1;`");
  });

  it("grows the fence past the longest backtick run inside", () => {
    expect(inlineCode("a ``b`` c")).toBe("```a ``b`` c```");
  });

  it("pads when the snippet starts or ends with a backtick", () => {
    expect(inlineCode("`x")).toBe("`` `x ``");
  });
});

describe("formatReview", () => {
  it("is empty with nothing annotated", () => {
    expect(formatReview([])).toBe("");
  });

  it("counts annotations and files in the opening line", () => {
    const text = formatReview([
      comment({ id: "1", path: "src/a.ts" }),
      comment({ id: "2", path: "src/b.ts" }),
    ]);
    expect(text.split("\n")[0]).toBe("Revisão do diff — 2 anotações em 2 arquivos.");
  });

  it("uses the singular for one annotation in one file", () => {
    expect(formatReview([comment()]).split("\n")[0]).toBe(
      "Revisão do diff — 1 anotação em 1 arquivo.",
    );
  });

  it("names the project and the branch when it knows them", () => {
    const text = formatReview([comment()], { projectName: "Yard", branch: "main" });
    expect(text.split("\n")[0]).toContain("(Yard, branch main)");
  });

  it("groups by file and sorts each file by line", () => {
    const text = formatReview([
      comment({ id: "1", path: "src/b.ts", line: 5 }),
      comment({ id: "2", path: "src/a.ts", line: 90 }),
      comment({ id: "3", path: "src/a.ts", line: 12 }),
    ]);
    const heads = text.split("\n").filter((l) => l.startsWith("### "));
    expect(heads).toEqual(["### src/a.ts", "### src/b.ts"]);
    const aLines = text.slice(text.indexOf("### src/a.ts"), text.indexOf("### src/b.ts"));
    expect(aLines.indexOf("linha 12")).toBeLessThan(aLines.indexOf("linha 90"));
  });

  it("marks a comment on a removed line", () => {
    const text = formatReview([comment({ onOld: true, line: 7 })]);
    expect(text).toContain("**linha 7 (removida)**");
  });

  it("says 'arquivo' when there is no line to point at", () => {
    const text = formatReview([comment({ line: null, code: "" })]);
    expect(text).toContain("- **arquivo**");
    expect(text).not.toContain("**linha");
  });

  it("quotes the annotated line safely", () => {
    const text = formatReview([comment({ code: "  const s = `${a}`;  " })]);
    expect(text).toContain("``const s = `${a}`;``");
  });

  it("flattens a multi-line comment into one line", () => {
    const text = formatReview([comment({ body: "primeiro\n\nsegundo" })]);
    expect(text).toContain("  primeiro segundo");
  });

  it("closes with the instruction that makes it actionable", () => {
    expect(formatReview([comment()]).trimEnd()).toMatch(/o que mudou\.$/);
  });
});

describe("anchorKey", () => {
  it("separates the two sides of the same line number", () => {
    expect(anchorKey(10, false)).not.toBe(anchorKey(10, true));
  });

  it("has one key for the whole file", () => {
    expect(anchorKey(null, false)).toBe("file");
    expect(anchorKey(null, true)).toBe("file");
  });
});
