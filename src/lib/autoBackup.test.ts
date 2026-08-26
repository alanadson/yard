/**
 * The automatic backup is a timer nobody watches: the only proof it works
 * is the rule that decides *when* it fires. A rule that fires too often
 * fills the disk; one that never fires is the manual export with a switch
 * painted next to it. The clock comes in as a parameter, as everywhere else.
 */
import { describe, expect, it } from "vitest";

import {
  backupDue,
  describeLast,
  nextBackupAt,
  parseLastAuto,
  periodMs,
} from "./autoBackup";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 26, 4, 17);

describe("backupDue", () => {
  it("never comes due while the mode is off — even with no copy ever written", () => {
    expect(backupDue({ mode: "off", lastAt: 0, now: NOW })).toBe(false);
    expect(backupDue({ mode: "off", lastAt: NOW - 30 * DAY, now: NOW })).toBe(false);
  });

  it("comes due at once when nothing was ever written", () => {
    expect(backupDue({ mode: "daily", lastAt: 0, now: NOW })).toBe(true);
    expect(backupDue({ mode: "weekly", lastAt: 0, now: NOW })).toBe(true);
  });

  it("daily waits a full day after the last copy, not less", () => {
    expect(backupDue({ mode: "daily", lastAt: NOW - 23 * 3_600_000, now: NOW })).toBe(false);
    expect(backupDue({ mode: "daily", lastAt: NOW - DAY, now: NOW })).toBe(true);
  });

  it("weekly waits seven days", () => {
    expect(backupDue({ mode: "weekly", lastAt: NOW - 6 * DAY, now: NOW })).toBe(false);
    expect(backupDue({ mode: "weekly", lastAt: NOW - 7 * DAY, now: NOW })).toBe(true);
  });

  /**
   * A stamp from the future (a clock set back, a restored backup from another
   * machine) must not silence the backup until the calendar catches up.
   */
  it("a stamp in the future counts as due, not as a very recent copy", () => {
    expect(backupDue({ mode: "daily", lastAt: NOW + 3 * DAY, now: NOW })).toBe(true);
  });
});

describe("nextBackupAt", () => {
  it("is the last stamp plus the period, now when nothing was written, null when off", () => {
    expect(periodMs("daily")).toBe(DAY);
    expect(periodMs("weekly")).toBe(7 * DAY);
    expect(periodMs("off")).toBeNull();
    expect(nextBackupAt({ mode: "daily", lastAt: NOW - 3_600_000, now: NOW })).toBe(
      NOW - 3_600_000 + DAY,
    );
    expect(nextBackupAt({ mode: "weekly", lastAt: 0, now: NOW })).toBe(NOW);
    expect(nextBackupAt({ mode: "off", lastAt: NOW, now: NOW })).toBeNull();
  });
});

describe("parseLastAuto", () => {
  it("tolerates an absent key and garbage in the kv", () => {
    expect(parseLastAuto(undefined)).toBe(0);
    expect(parseLastAuto("")).toBe(0);
    expect(parseLastAuto("ontem")).toBe(0);
    expect(parseLastAuto("-5")).toBe(0);
    expect(parseLastAuto(String(NOW))).toBe(NOW);
  });
});

describe("describeLast", () => {
  it("says nunca, agora, há <x>, and the date once it is a month old", () => {
    expect(describeLast(0, NOW)).toBe("nunca");
    expect(describeLast(NOW - 5_000, NOW)).toBe("agora");
    expect(describeLast(NOW - 5 * 60_000, NOW)).toBe("há 5min");
    expect(describeLast(NOW - 3 * 3_600_000, NOW)).toBe("há 3h");
    expect(describeLast(NOW - 2 * DAY, NOW)).toBe("há 2 dias");
    expect(describeLast(NOW - 45 * DAY, NOW)).toMatch(/^em \d/);
  });
});
