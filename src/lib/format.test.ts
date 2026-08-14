/**
 * The formatters shown to the user. They were private helpers in five
 * components, which is how the same elapsed time came out worded two
 * different ways in two panels.
 */
import { describe, expect, it } from "vitest";

import { ago, compactCount, elapsed, kb, range, truncate } from "./format";

describe("ago", () => {
  it("calls anything under ten seconds 'agora'", () => {
    expect(ago(0)).toBe("agora");
    expect(ago(9_999)).toBe("agora");
  });

  it("steps through seconds, minutes and hours", () => {
    expect(ago(10_000)).toBe("10s");
    expect(ago(59_999)).toBe("59s");
    expect(ago(60_000)).toBe("1min");
    expect(ago(3_599_999)).toBe("59min");
    expect(ago(3_600_000)).toBe("1h");
  });
});

describe("elapsed", () => {
  it("drops the minutes below one", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(43_000)).toBe("43s");
  });

  it("pads the seconds once minutes appear", () => {
    expect(elapsed(60_000)).toBe("1m00s");
    expect(elapsed(127_000)).toBe("2m07s");
  });

  it("never goes negative", () => {
    expect(elapsed(-5_000)).toBe("0s");
  });
});

describe("compactCount", () => {
  it("switches unit at each thousand", () => {
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1_500)).toBe("1.5k");
    expect(compactCount(2_400_000)).toBe("2.4M");
  });
});

describe("kb", () => {
  it("defaults to whole kilobytes and honours the digits argument", () => {
    expect(kb(2048)).toBe("2 KB");
    expect(kb(1536, 1)).toBe("1.5 KB");
  });
});

describe("truncate", () => {
  it("only cuts past the limit", () => {
    expect(truncate("curto", 10)).toBe("curto");
    expect(truncate("abcdefghij", 4)).toBe("abcd…");
  });
});

describe("range", () => {
  it("is half-open and never negative", () => {
    expect(range(0, 3)).toEqual([0, 1, 2]);
    expect(range(2, 5)).toEqual([2, 3, 4]);
    expect(range(3, 3)).toEqual([]);
    expect(range(5, 1)).toEqual([]);
  });
});
