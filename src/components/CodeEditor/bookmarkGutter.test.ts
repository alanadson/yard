/**
 * Painting the line marks.
 *
 * The marks are stored as plain line numbers and the document they belong to
 * is edited by other people, an agent rewriting the file, a reload from
 * disk, a fold. So the numbers routinely point past the end of the text, and
 * `doc.line()` **throws** on a line that does not exist: asking CodeMirror for
 * line 400 of a forty line file takes the whole editor down.
 *
 * That is the whole reason this function exists instead of an inline loop.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";

import { bookmarkOffsets } from "./bookmarkGutter";

const doc = Text.of(["um", "dois", "tres", "quatro"]);

describe("bookmarkOffsets", () => {
  it("puts each mark at the start of its line", () => {
    // Lines are 0-based here and 1-based in CodeMirror: line 0 is offset 0,
    // line 1 starts after "um\\n".
    expect(bookmarkOffsets([0, 1], doc)).toEqual([0, 3]);
  });

  it("skips a mark past the end of the file", () => {
    expect(bookmarkOffsets([1, 400], doc)).toEqual([3]);
  });

  it("skips a mark before the beginning of the file", () => {
    expect(bookmarkOffsets([-1, 0], doc)).toEqual([0]);
  });

  it("hands them over in document order, whatever order they came in", () => {
    // A RangeSetBuilder requires ascending positions and throws otherwise.
    expect(bookmarkOffsets([2, 0], doc)).toEqual([0, 8]);
  });

  it("has nothing to paint for a file with no marks", () => {
    expect(bookmarkOffsets([], doc)).toEqual([]);
  });
});
