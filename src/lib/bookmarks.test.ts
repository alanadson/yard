/**
 * Line marks, the two or three places in a file you keep coming back to
 * while you work on it.
 *
 * They are deliberately dumber than a breakpoint: a set of line numbers per
 * document, and nothing that tries to follow the text as it is edited. The
 * honest limit is written into the tests below, because a mark that silently
 * drifts is worse than one the reader knows they have to re-place.
 */
import { describe, expect, it } from "vitest";

import {
  countOf,
  dropDoc,
  linesOf,
  NO_MARKS,
  nextAfter,
  prevBefore,
  parseBookmarks,
  serializeBookmarks,
  shiftFrom,
  toggle,
  type Bookmarks,
} from "./bookmarks";

describe("toggle", () => {
  it("puts a mark down and takes the same one back up", () => {
    const on = toggle(NO_MARKS, "a", 10);
    expect(linesOf(on, "a")).toEqual([10]);

    const off = toggle(on, "a", 10);
    expect(linesOf(off, "a")).toEqual([]);
  });

  it("keeps the marks of a file in reading order", () => {
    let marks: Bookmarks = NO_MARKS;
    for (const line of [40, 3, 22]) marks = toggle(marks, "a", line);

    expect(linesOf(marks, "a")).toEqual([3, 22, 40]);
  });

  it("keeps each file's marks to itself", () => {
    const marks = toggle(toggle(NO_MARKS, "a", 10), "b", 99);

    expect(linesOf(marks, "a")).toEqual([10]);
    expect(linesOf(marks, "b")).toEqual([99]);
  });

  it("leaves no empty entry behind when the last mark of a file goes", () => {
    // The record is persisted with the tabs; an entry per file ever marked
    // would grow forever.
    const marks = toggle(toggle(NO_MARKS, "a", 10), "a", 10);

    expect(Object.keys(marks)).toEqual([]);
  });
});

describe("nextAfter and prevBefore", () => {
  const marks = toggle(toggle(toggle(NO_MARKS, "a", 5), "a", 20), "a", 50);

  it("finds the next mark down the file", () => {
    expect(nextAfter(marks, "a", 6)).toBe(20);
  });

  it("wraps to the first mark from below the last one", () => {
    expect(nextAfter(marks, "a", 90)).toBe(5);
  });

  it("finds the previous mark up the file", () => {
    expect(prevBefore(marks, "a", 30)).toBe(20);
  });

  it("wraps to the last mark from above the first one", () => {
    expect(prevBefore(marks, "a", 1)).toBe(50);
  });

  it("stands still on the only mark there is", () => {
    const one = toggle(NO_MARKS, "a", 7);
    expect(nextAfter(one, "a", 7)).toBe(7);
    expect(prevBefore(one, "a", 7)).toBe(7);
  });

  it("has nowhere to go in a file with no marks", () => {
    expect(nextAfter(NO_MARKS, "a", 3)).toBeNull();
    expect(prevBefore(NO_MARKS, "a", 3)).toBeNull();
  });
});

describe("shiftFrom", () => {
  it("moves the marks below an inserted block down with the text", () => {
    // Not a full mapping, CodeMirror does that for decorations. This is the
    // one case worth handling: reloading a file from disk after an agent
    // wrote to it, where all we know is how many lines the file gained.
    const marks = toggle(toggle(NO_MARKS, "a", 10), "a", 40);

    const moved = shiftFrom(marks, "a", 20, 5);

    expect(linesOf(moved, "a")).toEqual([10, 45]);
  });

  it("moves them back up when lines are removed", () => {
    const marks = toggle(toggle(NO_MARKS, "a", 10), "a", 40);

    expect(linesOf(shiftFrom(marks, "a", 20, -5), "a")).toEqual([10, 35]);
  });

  it("drops a mark that the removed lines swallowed", () => {
    const marks = toggle(toggle(NO_MARKS, "a", 22), "a", 40);

    expect(linesOf(shiftFrom(marks, "a", 20, -5), "a")).toEqual([35]);
  });
});

describe("dropDoc and countOf", () => {
  it("forgets a closed file", () => {
    const marks = toggle(toggle(NO_MARKS, "a", 1), "b", 2);

    expect(linesOf(dropDoc(marks, "a"), "a")).toEqual([]);
    expect(linesOf(dropDoc(marks, "a"), "b")).toEqual([2]);
  });

  it("counts what a file has", () => {
    expect(countOf(toggle(toggle(NO_MARKS, "a", 1), "a", 9), "a")).toBe(2);
    expect(countOf(NO_MARKS, "a")).toBe(0);
  });
});


describe("the record on disk", () => {
  it("writes and reads back the same marks", () => {
    const marks = toggle(toggle(toggle(NO_MARKS, "a", 3), "a", 9), "b", 1);

    expect(parseBookmarks(serializeBookmarks(marks))).toEqual(marks);
  });

  it("writes nothing for a workspace with no marks", () => {
    expect(serializeBookmarks(NO_MARKS)).toBe("");
    expect(parseBookmarks("")).toEqual(NO_MARKS);
  });

  it("treats what comes off disk as input, never as data we wrote", () => {
    // A throw here costs the user every unsaved draft in the restore.
    expect(parseBookmarks("not json")).toEqual(NO_MARKS);
    expect(parseBookmarks("[1,2,3]")).toEqual(NO_MARKS);
    expect(parseBookmarks('{"a":"nope"}')).toEqual(NO_MARKS);
    expect(parseBookmarks('{"a":[3,"x",-1,9,9]}')).toEqual({ a: [3, 9] });
  });
});
