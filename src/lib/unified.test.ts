/**
 * A unified diff, built in the front end.
 *
 * Every comparison the app shows so far comes from git, which means the one
 * comparison it could never show is the one that is not in git yet: the draft
 * against what is on disk. "What is Ctrl+S about to write?" is a fair
 * question, and in a window where agents edit the same files it is a question
 * people ask often.
 *
 * The output has to be a real unified diff, because it is handed to the same
 * viewer that renders git's own. The two rules that make it real are the hunk
 * header arithmetic and the merging: two changes three lines apart share one
 * hunk, and getting either wrong produces something that renders but lies.
 */
import { describe, expect, it } from "vitest";

import { unifiedDiff } from "./unified";

const lines = (...rows: string[]) => rows.join("\n");

describe("unifiedDiff", () => {
  it("says nothing about two identical texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "src/a.ts")).toBe("");
  });

  it("names both sides in the header", () => {
    const out = unifiedDiff("a", "b", "src/a.ts");

    expect(out).toContain("--- a/src/a.ts");
    expect(out).toContain("+++ b/src/a.ts");
  });

  it("writes a changed line as a removal and an addition", () => {
    const out = unifiedDiff(lines("um", "dois", "tres"), lines("um", "DOIS", "tres"), "a.ts");

    expect(out).toContain("-dois");
    expect(out).toContain("+DOIS");
    expect(out).toContain(" um");
    expect(out).toContain(" tres");
  });

  it("counts the lines of each side in the hunk header", () => {
    // `@@ -1,3 +1,3 @@`: one changed line with one line of context each side.
    const out = unifiedDiff(lines("um", "dois", "tres"), lines("um", "DOIS", "tres"), "a.ts");

    expect(out).toContain("@@ -1,3 +1,3 @@");
  });

  it("counts an addition as one more line on the new side", () => {
    const out = unifiedDiff(lines("um", "tres"), lines("um", "dois", "tres"), "a.ts");

    expect(out).toContain("@@ -1,2 +1,3 @@");
    expect(out).toContain("+dois");
  });

  it("keeps at most three lines of context around a change", () => {
    const old = lines("1", "2", "3", "4", "5", "X", "7", "8", "9", "10");
    const now = lines("1", "2", "3", "4", "5", "Y", "7", "8", "9", "10");

    const out = unifiedDiff(old, now, "a.ts");

    expect(out).toContain("@@ -3,7 +3,7 @@");
    expect(out).not.toContain(" 1\n");
    expect(out).not.toContain(" 10");
  });

  it("puts two nearby changes in one hunk", () => {
    // Their context windows touch, so a second header between them would be
    // wrong: the ranges would overlap and no tool could apply the result.
    const old = lines("1", "X", "3", "4", "5", "Y", "7");
    const now = lines("1", "A", "3", "4", "5", "B", "7");

    const out = unifiedDiff(old, now, "a.ts")!;

    expect(out.match(/^@@/gm)).toHaveLength(1);
  });

  it("keeps two distant changes in two hunks", () => {
    const rows = Array.from({ length: 40 }, (_, i) => String(i + 1));
    const old = lines(...rows);
    const changed = [...rows];
    changed[1] = "X";
    changed[35] = "Y";

    const out = unifiedDiff(old, lines(...changed), "a.ts")!;

    expect(out.match(/^@@/gm)).toHaveLength(2);
  });

  it("handles a change at the very first line", () => {
    const out = unifiedDiff(lines("um", "dois"), lines("UM", "dois"), "a.ts");

    expect(out).toContain("@@ -1,2 +1,2 @@");
  });

  it("handles a file that only gained lines at the end", () => {
    const out = unifiedDiff(lines("um"), lines("um", "dois"), "a.ts");

    expect(out).toContain("+dois");
  });

  it("reads a CRLF buffer without spilling carriage returns into the diff", () => {
    // The buffer keeps whatever the file had. A `\r` left on the end of every
    // line would show up as a change on every line.
    const out = unifiedDiff("um\r\ndois\r\n", "um\r\nDOIS\r\n", "a.ts");

    expect(out).toContain("-dois");
    expect(out).not.toContain("\r");
  });

  it("gives up rather than lying when the texts are too far apart", () => {
    // `diffLines` has an edit budget; past it there is no answer to render.
    const old = Array.from({ length: 9000 }, (_, i) => `a${i}`).join("\n");
    const now = Array.from({ length: 9000 }, (_, i) => `b${i}`).join("\n");

    expect(unifiedDiff(old, now, "a.ts")).toBeNull();
  });
});
