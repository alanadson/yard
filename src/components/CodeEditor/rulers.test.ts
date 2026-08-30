/**
 * The column guides, the faint vertical lines at 80 and 120 that tell you a
 * line is getting long without a wrap or a warning.
 *
 * The preference is free text, because "80" and "80, 120" and "100" are all
 * legitimate answers and a number field would only fit the first. Free text
 * means the parsing is where the bugs live, so that is what is pinned here:
 * whatever the field holds, the editor gets a clean, ordered, bounded list or
 * it gets nothing at all.
 */
import { describe, expect, it } from "vitest";

import { MAX_RULERS, parseRulers } from "./rulers";

describe("parseRulers", () => {
  it("reads a single column", () => {
    expect(parseRulers("80")).toEqual([80]);
  });

  it("reads a list however it was punctuated", () => {
    expect(parseRulers("80, 120")).toEqual([80, 120]);
    expect(parseRulers("80 120")).toEqual([80, 120]);
    expect(parseRulers("80;120")).toEqual([80, 120]);
  });

  it("puts the columns in order and says each one once", () => {
    expect(parseRulers("120, 80, 120")).toEqual([80, 120]);
  });

  it("throws away what is not a column", () => {
    // A guide at column zero is the left edge, and a negative one is nothing.
    expect(parseRulers("80, oitenta, -4, 0, 3.5")).toEqual([80]);
  });

  it("has nothing to draw for an empty or absent setting", () => {
    expect(parseRulers("")).toEqual([]);
    expect(parseRulers("   ")).toEqual([]);
    expect(parseRulers(undefined)).toEqual([]);
  });

  it("stops at a handful, past that they are stripes, not guides", () => {
    const many = Array.from({ length: MAX_RULERS + 4 }, (_, i) => String((i + 1) * 10));

    expect(parseRulers(many.join(","))).toHaveLength(MAX_RULERS);
  });

  it("refuses a column too far right to ever be reached", () => {
    expect(parseRulers("100000")).toEqual([]);
  });
});
