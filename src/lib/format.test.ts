/**
 * The formatters shown to the user. They were private helpers in five
 * components, which is how the same elapsed time came out worded two
 * different ways in two panels.
 */
import { describe, expect, it } from "vitest";

import {
  ago,
  compactCount,
  elapsed,
  kb,
  range,
  since,
  truncate,
  untilShort,
} from "./format";

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

describe("untilShort", () => {
  it("never claims zero — a reset in the future is at least '<1min'", () => {
    expect(untilShort(0)).toBe("<1min");
    expect(untilShort(59_999)).toBe("<1min");
  });

  it("uses two units at most, padding minutes under hours", () => {
    expect(untilShort(23 * 60_000)).toBe("23min");
    expect(untilShort(4 * 3_600_000 + 5 * 60_000)).toBe("4h 05min");
    expect(untilShort(5 * 86_400_000 + 11 * 3_600_000)).toBe("5d 11h");
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

/**
 * A commit's date is not "how long ago that ran": it is a date, and the ones
 * in the history range from seconds ago to years ago. `ago` stops at hours —
 * a three-month-old commit came out as "2160h", a number nobody reads as
 * time. The clock comes in as a parameter because the test cannot depend on
 * when it runs.
 */
describe("since", () => {
  // 2026-08-21T12:00:00Z, in seconds and in ms.
  const NOW = 1_787_400_000_000;
  const s = (secondsAgo: number) => NOW / 1000 - secondsAgo;

  it("what just happened gets no number", () => {
    expect(since(s(5), NOW)).toBe("agora");
    expect(since(s(59), NOW)).toBe("agora");
  });

  it("minutes and hours stay compact, like the rest of the app", () => {
    expect(since(s(60), NOW)).toBe("1min");
    expect(since(s(3600), NOW)).toBe("1h");
    expect(since(s(3600 * 23), NOW)).toBe("23h");
  });

  it("from a day to a month, counts in days", () => {
    expect(since(s(86_400), NOW)).toBe("1 dia");
    expect(since(s(86_400 * 6), NOW)).toBe("6 dias");
  });

  it("past a month it becomes a date — the day count stops helping", () => {
    expect(since(s(86_400 * 60), NOW)).toMatch(/\d/);
    expect(since(s(86_400 * 60), NOW)).not.toContain("dias");
  });

  it("a date from last year carries the year along", () => {
    expect(since(s(86_400 * 500), NOW)).toMatch(/20\d\d/);
  });

  it("a commit dated in the future (skewed machine clock) does not go negative", () => {
    expect(since(s(-3600), NOW)).toBe("agora");
  });

  it("without a date, does not invent one", () => {
    expect(since(0, NOW)).toBe("");
  });
});
