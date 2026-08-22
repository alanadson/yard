/**
 * Staging a hunk (and not the whole file) means building a new patch from the
 * diff on screen and handing it to `git apply`. Everything here is `@@`
 * header arithmetic, and `git apply` is relentless: one wrong count and it
 * refuses the whole patch — without saying which line was wrong, and after
 * the person has already clicked.
 *
 * The two rules nobody gets right the first time, and that these tests lock in:
 *
 * 1. **an unpicked `+` line vanishes; an unpicked `-` line becomes context.**
 *    It is asymmetric on purpose: the old side of the patch has to describe
 *    the *whole* file as it is today, and the new side only what is going in.
 * 2. **the `@@` counts are recounted after that**, never copied from the
 *    original diff.
 *
 * And the third, which only shows up in a file with no trailing newline: the
 * `\ No newline…` marker belongs to the line above and goes (or stays) with it.
 */
import { describe, expect, it } from "vitest";

import { capHunks, patchForHunks, patchForLines, splitPatch } from "./scmPatch";

/** Two distant hunks in the same file — the case that motivates all of this. */
const TWO_HUNKS = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@",
  "-um",
  "+UM",
  " dois",
  " tres",
  "@@ -8,3 +8,4 @@",
  " oito",
  "-nove",
  "+NOVE",
  "+NOVE E MEIO",
  " dez",
  "",
].join("\n");

describe("splitPatch", () => {
  it("separates the header from the hunks without losing a line of the original text", () => {
    const { header, hunks } = splitPatch(TWO_HUNKS);
    expect(header).toEqual([
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
    ]);
    expect(hunks.length).toBe(2);
    expect(hunks[0].header).toBe("@@ -1,3 +1,3 @@");
    expect(hunks[0].lines).toEqual(["-um", "+UM", " dois", " tres"]);
    expect(hunks[1].oldStart).toBe(8);
    expect(hunks[1].newStart).toBe(8);
  });

  it("counts what each hunk adds and removes — it is the button's label", () => {
    const { hunks } = splitPatch(TWO_HUNKS);
    expect(hunks[0].additions).toBe(1);
    expect(hunks[0].deletions).toBe(1);
    expect(hunks[1].additions).toBe(2);
    expect(hunks[1].deletions).toBe(1);
  });

  it("an `@@ -1 +1 @@` with no comma counts as one line each", () => {
    const { hunks } = splitPatch(
      ["--- a/x", "+++ b/x", "@@ -4 +4 @@", "-a", "+b", ""].join("\n"),
    );
    expect(hunks[0].oldStart).toBe(4);
    expect(hunks[0].oldCount).toBe(1);
    expect(hunks[0].newCount).toBe(1);
  });

  it("text with no `@@` at all has no hunk — and does not blow up", () => {
    expect(splitPatch("Binary files a/x and b/x differ\n").hunks).toEqual([]);
    expect(splitPatch("").hunks).toEqual([]);
  });
});

describe("patchForHunks", () => {
  it("carries the header and only the chosen hunk, word for word", () => {
    const patch = patchForHunks(TWO_HUNKS, [1]);
    expect(patch).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        "index 1111111..2222222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -8,3 +8,4 @@",
        " oito",
        "-nove",
        "+NOVE",
        "+NOVE E MEIO",
        " dez",
        "",
      ].join("\n"),
    );
  });

  it("two chosen hunks come out in file order, not click order", () => {
    const patch = patchForHunks(TWO_HUNKS, [1, 0]);
    expect(patch.indexOf("@@ -1,3")).toBeLessThan(patch.indexOf("@@ -8,3"));
  });

  it("always ends in a newline — without it `git apply` refuses", () => {
    expect(patchForHunks(TWO_HUNKS, [0]).endsWith("\n")).toBe(true);
  });

  it("no chosen hunk is no patch at all, not an empty patch that 'applies'", () => {
    expect(patchForHunks(TWO_HUNKS, [])).toBe("");
  });

  it("an index that does not exist is ignored instead of becoming a crooked hunk", () => {
    expect(patchForHunks(TWO_HUNKS, [9])).toBe("");
  });
});

describe("patchForLines", () => {
  it("an unpicked `+` line vanishes from the patch", () => {
    // Only the first `+` of the second hunk; "NOVE E MEIO" stays out.
    const patch = patchForLines(TWO_HUNKS, 1, new Set([1, 2]));
    expect(patch).toContain("+NOVE");
    expect(patch).not.toContain("NOVE E MEIO");
  });

  it("an unpicked `-` line becomes context — the old side describes the whole file", () => {
    // Only the `+`: the `-nove` was not chosen, so it still exists.
    const patch = patchForLines(TWO_HUNKS, 1, new Set([2]));
    const lines = patch.split("\n");
    expect(lines).toContain(" nove");
    expect(lines).not.toContain("-nove");
    expect(lines).toContain("+NOVE");
  });

  it("both `@@` counts are recounted after the cut", () => {
    // Hunk 1 is `@@ -8,3 +8,4 @@`. Choosing only the `-nove`, both `+` lines
    // vanish: the old side stays at 3 (oito, nove, dez) and the new one drops
    // to 2. Copying the original header here would be a refused patch.
    const patch = patchForLines(TWO_HUNKS, 1, new Set([1]));
    expect(patch.split("\n").find((l) => l.startsWith("@@"))).toBe("@@ -8,3 +8,2 @@");
    expect(patch).not.toContain("+NOVE");
  });

  it("the new side starts where the old one starts — the patch is applied on top of the old side", () => {
    const patch = patchForLines(TWO_HUNKS, 0, new Set([0, 1]));
    expect(patch.split("\n").find((l) => l.startsWith("@@"))).toBe("@@ -1,3 +1,3 @@");
  });

  it("choosing nothing means nothing to apply", () => {
    expect(patchForLines(TWO_HUNKS, 1, new Set())).toBe("");
  });

  it("choosing only context lines also means nothing to apply", () => {
    // Indices 0 and 4 of hunk 1 are " oito" and " dez" — pure context.
    expect(patchForLines(TWO_HUNKS, 1, new Set([0, 4]))).toBe("");
  });

  it("the 'no trailing newline' marker follows the line it describes", () => {
    const noBreak = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " um",
      "-dois",
      "\\ No newline at end of file",
      "+DOIS",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const everything = patchForLines(noBreak, 0, new Set([1, 3]));
    expect(everything.split("\n").filter((l) => l.startsWith("\\")).length).toBe(2);

    // Leaving the `-dois` out turns it into context — and its marker stays,
    // because it is still true about that line.
    const only = patchForLines(noBreak, 0, new Set([3]));
    expect(only).toContain(" dois");
    expect(only).toContain("+DOIS");
  });

  it("a hunk that does not exist does not become a patch", () => {
    expect(patchForLines(TWO_HUNKS, 7, new Set([0]))).toBe("");
  });

  it("the file header comes along — without it git does not know what to apply to", () => {
    const patch = patchForLines(TWO_HUNKS, 0, new Set([0, 1]));
    expect(patch.startsWith("diff --git a/a.txt b/a.txt\n")).toBe(true);
    expect(patch).toContain("--- a/a.txt");
    expect(patch).toContain("+++ b/a.txt");
  });
});

/**
 * The cap on drawn lines.
 *
 * The regression that motivated this: the backend cuts the diff at 1 MB,
 * which still fits ~20 thousand lines — and every line of the hunk becomes a
 * `<span>` with `onClick`, `onKeyDown`, `role` and `tabIndex`, because lines
 * can be picked one by one. Opening a regenerated `package-lock.json` inside
 * the Source Control tab froze the window for seconds. The cut is by **drawn
 * lines**, not by hunk: a diff can have one giant hunk or a thousand small
 * ones, and both freeze.
 */
describe("capHunks", () => {
  const hunk = (lines: number) =>
    `@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => ` l${i}`).join("\n")}\n`;

  it("a huge diff draws only the line cap and says how many were left out", () => {
    const { hunks } = splitPatch(`--- a\n+++ b\n${hunk(5000)}`);
    const cut = capHunks(hunks, 1_500);
    expect(cut.hunks).toHaveLength(1);
    expect(cut.hunks[0].lines).toHaveLength(1_500);
    expect(cut.hiddenLines).toBe(3_500);
    expect(cut.hiddenHunks).toBe(0);
  });

  it("a thousand small hunks stop at the same cap — a hunk goes in whole or not at all", () => {
    const theText = `--- a\n+++ b\n${Array.from({ length: 40 }, () => hunk(100)).join("")}`;
    const { hunks } = splitPatch(theText);
    const cut = capHunks(hunks, 1_500);
    expect(cut.hunks).toHaveLength(15);
    expect(cut.hiddenHunks).toBe(25);
    expect(cut.hiddenLines).toBe(2_500);
  });

  it("the first hunk always shows, even when it alone is bigger than the cap", () => {
    const { hunks } = splitPatch(`--- a\n+++ b\n${hunk(9)}`);
    const cut = capHunks(hunks, 4);
    expect(cut.hunks).toHaveLength(1);
    expect(cut.hunks[0].lines).toHaveLength(4);
    expect(cut.hiddenLines).toBe(5);
  });

  it("what fits passes untouched — same reference, no copy per render", () => {
    const { hunks } = splitPatch(`--- a\n+++ b\n${hunk(10)}`);
    const cut = capHunks(hunks, 1_500);
    expect(cut.hunks).toBe(hunks);
    expect(cut.hiddenLines).toBe(0);
    expect(cut.hiddenHunks).toBe(0);
  });

  it("the hunk's index survives the cut — it is how the button asks for the patch", () => {
    const text = `--- a\n+++ b\n${Array.from({ length: 5 }, () => hunk(400)).join("")}`;
    const { hunks } = splitPatch(text);
    const cut = capHunks(hunks, 1_200);
    expect(cut.hunks.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(cut.hiddenHunks).toBe(2);
  });
});
