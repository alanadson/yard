/**
 * The switch that actually stops spending. A budget that only shows a chip
 * while six agents keep feeding each other is a rear-view mirror; this is
 * the rule that turns "over the ceiling" (or "the five-hour window is almost
 * gone") into automation that stops, and the rule that keeps a user who
 * chose to resume from being paused again by the same reason the same day.
 * The clock is always passed in, and the local day is computed from it.
 */
import { describe, expect, it } from "vitest";

import type { ProviderUsage } from "./ipc";
import {
  parsePause,
  pausedReply,
  pauseToApply,
  quotaPeak,
  serializePause,
  suppressAfterResume,
  type PauseSuppression,
} from "./automationPause";

const NOW = new Date(2026, 9, 19, 15, 0).getTime();
const TOMORROW = new Date(2026, 9, 20, 9, 0).getTime();
const PREFS = { budgetPauseAutomation: true, quotaPausePct: 90 };

function provider(windows: { key: string; usedPercent: number; windowMinutes: number }[]): ProviderUsage {
  return {
    id: "claude",
    name: "Claude",
    plan: null,
    account: null,
    windows: windows.map((w) => ({ ...w, resetsAt: null })),
    status: "ok",
    error: null,
    updatedAt: 0,
  };
}

describe("the kv value", () => {
  it("reads the contract's JSON and treats empty or junk as not paused", () => {
    expect(parsePause('{"reason":"budget","at":5}')).toEqual({ reason: "budget", at: 5 });
    expect(parsePause("")).toBeNull();
    expect(parsePause(undefined)).toBeNull();
    expect(parsePause("{nope")).toBeNull();
    expect(parsePause('{"reason":"lunch","at":5}')).toBeNull();
  });

  it("writes JSON for a pause and the empty string for none", () => {
    expect(parsePause(serializePause({ reason: "quota", at: 7 }))).toEqual({ reason: "quota", at: 7 });
    expect(serializePause(null)).toBe("");
  });
});

describe("quotaPeak", () => {
  it("is the most used five-hour window across providers, ignoring the weekly ones", () => {
    const providers = [
      provider([
        { key: "session", usedPercent: 40, windowMinutes: 300 },
        { key: "weekly", usedPercent: 97, windowMinutes: 10_080 },
      ]),
      provider([{ key: "session", usedPercent: 72, windowMinutes: 300 }]),
    ];
    expect(quotaPeak(providers)).toBe(72);
  });

  it("is null when no provider reported a five-hour window", () => {
    expect(quotaPeak([provider([{ key: "weekly", usedPercent: 99, windowMinutes: 10_080 }])])).toBeNull();
  });
});

describe("pauseToApply", () => {
  it("pauses for the budget when the day is over and the preference is on", () => {
    expect(
      pauseToApply({ budgetLevel: "over", prefs: PREFS, current: null, suppressed: null, now: NOW }),
    ).toEqual({ reason: "budget", at: NOW });
  });

  it("does not pause for the budget when the preference is off, or the day is only warned", () => {
    const off = { ...PREFS, budgetPauseAutomation: false };
    expect(pauseToApply({ budgetLevel: "over", prefs: off, current: null, suppressed: null, now: NOW })).toBeNull();
    expect(pauseToApply({ budgetLevel: "warn", prefs: PREFS, current: null, suppressed: null, now: NOW })).toBeNull();
  });

  it("pauses for the quota when a five-hour window reaches the threshold, and never at zero", () => {
    expect(pauseToApply({ quotaPct: 90, prefs: PREFS, current: null, suppressed: null, now: NOW })).toEqual({
      reason: "quota",
      at: NOW,
    });
    expect(pauseToApply({ quotaPct: 89, prefs: PREFS, current: null, suppressed: null, now: NOW })).toBeNull();
    const off = { ...PREFS, quotaPausePct: 0 };
    expect(pauseToApply({ quotaPct: 100, prefs: off, current: null, suppressed: null, now: NOW })).toBeNull();
  });

  it("changes nothing while a pause is already in force", () => {
    const current = { reason: "quota" as const, at: 1 };
    expect(pauseToApply({ budgetLevel: "over", prefs: PREFS, current, suppressed: null, now: NOW })).toBeNull();
  });

  /**
   * The user saw the chip, decided the work was worth it and resumed. The same
   * reason pausing them again five minutes later is the app overruling them.
   */
  it("does not pause again for a reason the user resumed from today, but does tomorrow", () => {
    const suppressed: PauseSuppression = suppressAfterResume(null, { reason: "budget", at: 1 }, NOW);
    expect(pauseToApply({ budgetLevel: "over", prefs: PREFS, current: null, suppressed, now: NOW })).toBeNull();
    expect(pauseToApply({ quotaPct: 95, prefs: PREFS, current: null, suppressed, now: NOW })).toEqual({
      reason: "quota",
      at: NOW,
    });
    expect(
      pauseToApply({ budgetLevel: "over", prefs: PREFS, current: null, suppressed, now: TOMORROW }),
    ).toEqual({ reason: "budget", at: TOMORROW });
  });
});

describe("suppressAfterResume", () => {
  it("adds the reason to today's list and starts a new list on a new day", () => {
    const first = suppressAfterResume(null, { reason: "budget", at: 1 }, NOW);
    expect(first).toEqual({ day: "2026-10-19", reasons: ["budget"] });
    expect(suppressAfterResume(first, { reason: "quota", at: 2 }, NOW)).toEqual({
      day: "2026-10-19",
      reasons: ["budget", "quota"],
    });
    expect(suppressAfterResume(first, { reason: "quota", at: 2 }, TOMORROW)).toEqual({
      day: "2026-10-20",
      reasons: ["quota"],
    });
  });
});

describe("pausedReply", () => {
  it("tells the calling agent why nothing was sent and who can resume", () => {
    const reply = pausedReply({ reason: "budget", at: NOW });
    expect(reply).toContain("pausada");
    expect(reply).toContain("orçamento");
    expect(reply).toContain("usuário");
    expect(reply.endsWith("\n")).toBe(true);
  });
});
