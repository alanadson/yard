/**
 * Doing something about the git calha, rather than only looking at it.
 *
 * The strip beside the line numbers has always known which lines are born,
 * changed or gone. What it could not do is say *what they were*, or put them
 * back, because `LineChanges` only ever described the new side of the file.
 *
 * A hunk carries both sides, and that is what the three things below need: a
 * peek that shows the old text, a revert that writes it back, and the two
 * keys that walk from one change to the next.
 *
 * The revert is the one with teeth. It replaces a range of the buffer with a
 * range of the file as git has it, so an off-by-one here does not fail, it
 * silently eats a line of somebody's work.
 */
import { describe, expect, it } from "vitest";

import { diffLines } from "./lineDiff";
import {
  hunkAt,
  minimalEdit,
  nextHunk,
  peekLines,
  prevHunk,
  revertHunk,
} from "./hunks";

const head = ["um", "dois", "tres", "quatro", "cinco"].join("\n");

/** The hunks of a change, through the same door the gutter uses. */
function hunksOf(oldText: string, newText: string) {
  return diffLines(oldText, newText)?.hunks ?? [];
}

describe("the hunks of a change", () => {
  it("has none for a file that matches HEAD", () => {
    expect(hunksOf(head, head)).toEqual([]);
  });

  it("describes a changed line on both sides", () => {
    const buffer = ["um", "DOIS", "tres", "quatro", "cinco"].join("\n");

    expect(hunksOf(head, buffer)).toEqual([
      { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 2 },
    ]);
  });

  it("describes an inserted line as owning no old line at all", () => {
    // `oldTo < oldFrom` is the empty old range: nothing to put back here, the
    // revert simply deletes.
    const buffer = ["um", "novo", "dois", "tres", "quatro", "cinco"].join("\n");

    expect(hunksOf(head, buffer)).toEqual([
      { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 1 },
    ]);
  });

  it("describes a deleted line as owning no new line at all", () => {
    const buffer = ["um", "tres", "quatro", "cinco"].join("\n");

    expect(hunksOf(head, buffer)).toEqual([
      { newFrom: 2, newTo: 1, oldFrom: 2, oldTo: 2 },
    ]);
  });

  it("keeps two separate changes apart", () => {
    const buffer = ["UM", "dois", "tres", "quatro", "CINCO"].join("\n");

    expect(hunksOf(head, buffer)).toEqual([
      { newFrom: 1, newTo: 1, oldFrom: 1, oldTo: 1 },
      { newFrom: 5, newTo: 5, oldFrom: 5, oldTo: 5 },
    ]);
  });

  it("puts a block that shrank into one hunk", () => {
    const buffer = ["um", "X", "cinco"].join("\n");

    const hunks = hunksOf(head, buffer);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({ newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 4 });
  });
});

describe("hunkAt", () => {
  const hunks = [
    { newFrom: 2, newTo: 3, oldFrom: 2, oldTo: 2 },
    { newFrom: 9, newTo: 8, oldFrom: 9, oldTo: 10 },
  ];

  it("finds the hunk the line is inside", () => {
    expect(hunkAt(hunks, 3)).toBe(hunks[0]);
  });

  it("has nothing for a line no hunk touches", () => {
    expect(hunkAt(hunks, 6)).toBeNull();
  });

  it("finds a pure deletion from the line it sits above", () => {
    // A deletion owns no new line, so the only place to click on it is the
    // line that took its place.
    expect(hunkAt(hunks, 9)).toBe(hunks[1]);
  });
});

describe("nextHunk and prevHunk", () => {
  const hunks = [
    { newFrom: 3, newTo: 3, oldFrom: 3, oldTo: 3 },
    { newFrom: 10, newTo: 12, oldFrom: 10, oldTo: 10 },
    { newFrom: 40, newTo: 40, oldFrom: 38, oldTo: 38 },
  ];

  it("goes to the next change below the caret", () => {
    expect(nextHunk(hunks, 5)?.newFrom).toBe(10);
  });

  it("wraps to the first change from below the last", () => {
    expect(nextHunk(hunks, 90)?.newFrom).toBe(3);
  });

  it("goes to the previous change above the caret", () => {
    expect(prevHunk(hunks, 20)?.newFrom).toBe(10);
  });

  it("wraps to the last change from above the first", () => {
    expect(prevHunk(hunks, 1)?.newFrom).toBe(40);
  });

  it("does not stand still on the hunk the caret is already in", () => {
    // Pressing the key twice must move twice.
    expect(nextHunk(hunks, 10)?.newFrom).toBe(40);
    expect(prevHunk(hunks, 10)?.newFrom).toBe(3);
  });

  it("has nowhere to go in a file with no changes", () => {
    expect(nextHunk([], 1)).toBeNull();
    expect(prevHunk([], 1)).toBeNull();
  });
});

describe("revertHunk", () => {
  it("puts a changed line back the way git has it", () => {
    const buffer = ["um", "DOIS", "tres"].join("\n");
    const headText = ["um", "dois", "tres"].join("\n");
    const hunk = { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 2 };

    expect(revertHunk(buffer, headText, hunk)).toBe(headText);
  });

  it("takes an added line back out", () => {
    const buffer = ["um", "novo", "dois"].join("\n");
    const headText = ["um", "dois"].join("\n");
    const hunk = { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 1 };

    expect(revertHunk(buffer, headText, hunk)).toBe(headText);
  });

  it("brings a deleted line back", () => {
    const buffer = ["um", "tres"].join("\n");
    const headText = ["um", "dois", "tres"].join("\n");
    const hunk = { newFrom: 2, newTo: 1, oldFrom: 2, oldTo: 2 };

    expect(revertHunk(buffer, headText, hunk)).toBe(headText);
  });

  it("puts a whole shrunken block back", () => {
    const buffer = ["um", "X", "cinco"].join("\n");
    const headText = ["um", "dois", "tres", "quatro", "cinco"].join("\n");
    const hunk = { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 4 };

    expect(revertHunk(buffer, headText, hunk)).toBe(headText);
  });

  it("leaves the rest of the buffer alone", () => {
    // Only the hunk goes back. Everything the user changed elsewhere stays.
    const buffer = ["UM", "DOIS", "tres"].join("\n");
    const headText = ["um", "dois", "tres"].join("\n");
    const hunk = { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 2 };

    expect(revertHunk(buffer, headText, hunk)).toBe(["UM", "dois", "tres"].join("\n"));
  });

  it("keeps the CRLF the buffer was written with", () => {
    // A revert that normalised the line endings would turn one line into a
    // whole-file diff.
    const buffer = ["um", "DOIS", "tres"].join("\r\n");
    const headText = ["um", "dois", "tres"].join("\n");
    const hunk = { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 2 };

    expect(revertHunk(buffer, headText, hunk)).toBe(["um", "dois", "tres"].join("\r\n"));
  });

  it("refuses a hunk that points outside the file it is given", () => {
    // The buffer moves under the marks between recomputes. Writing from a
    // stale hunk is how a revert eats a line nobody asked it to.
    const buffer = ["um", "dois"].join("\n");
    const headText = ["um", "dois"].join("\n");

    expect(revertHunk(buffer, headText, { newFrom: 9, newTo: 9, oldFrom: 1, oldTo: 1 })).toBeNull();
    expect(revertHunk(buffer, headText, { newFrom: 1, newTo: 1, oldFrom: 9, oldTo: 9 })).toBeNull();
  });
});

describe("peekLines", () => {
  const headText = ["um", "dois", "tres"].join("\n");

  it("shows the lines HEAD has for the hunk", () => {
    expect(peekLines(headText, { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 3 })).toEqual([
      "dois",
      "tres",
    ]);
  });

  it("shows nothing for a line that is new", () => {
    // There is no old text to peek at; the panel says so in words instead of
    // opening empty.
    expect(peekLines(headText, { newFrom: 2, newTo: 2, oldFrom: 2, oldTo: 1 })).toEqual([]);
  });

  it("shows nothing rather than guessing when the hunk does not fit", () => {
    expect(peekLines(headText, { newFrom: 1, newTo: 1, oldFrom: 9, oldTo: 9 })).toEqual([]);
  });
});

/**
 * The revert knows the whole new text; the editor wants the smallest change
 * that produces it. Replacing the document wholesale would work and would
 * cost the reader their caret and one undo step for the entire file.
 */
describe("minimalEdit", () => {
  it("finds the one span that differs", () => {
    expect(minimalEdit("um dois tres", "um DOIS tres")).toEqual({
      from: 3,
      to: 7,
      insert: "DOIS",
    });
  });

  it("describes an insertion as an empty span", () => {
    expect(minimalEdit("um tres", "um dois tres")).toEqual({
      from: 3,
      to: 3,
      insert: "dois ",
    });
  });

  it("describes a deletion as an empty replacement", () => {
    expect(minimalEdit("um dois tres", "um tres")).toEqual({
      from: 3,
      to: 8,
      insert: "",
    });
  });

  it("has nothing to change between two equal texts", () => {
    expect(minimalEdit("igual", "igual")).toBeNull();
  });

  it("handles a text that lost everything", () => {
    expect(minimalEdit("algo", "")).toEqual({ from: 0, to: 4, insert: "" });
  });

  it("handles a text that started empty", () => {
    expect(minimalEdit("", "algo")).toEqual({ from: 0, to: 0, insert: "algo" });
  });

  it("does not let the common tail run past the common head", () => {
    // The regression this locks: counting the shared "aa" from both ends of
    // "aaa" twice produces a span that ends before it starts.
    const edit = minimalEdit("aaa", "aa");

    expect(edit).not.toBeNull();
    expect(edit!.to).toBeGreaterThanOrEqual(edit!.from);
  });
});
