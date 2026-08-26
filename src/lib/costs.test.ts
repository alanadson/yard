/**
 * The "Custos e uso" panel is arithmetic over rows the backend already
 * bucketed by day/agent/project/model. These rules decide what the user reads
 * as "how much did I spend": a sum that quietly dropped the unpriced rows,
 * or a range that missed yesterday because of a time-zone slip, would be a
 * number that looks exact and is wrong — the worst kind.
 */
import { describe, expect, it } from "vitest";

import {
  bucketBy,
  daySeries,
  dayLabel,
  filterRange,
  formatTokens,
  formatUsd,
  localDay,
  projectLabel,
  totals,
  type UsageRow,
} from "./costs";

function row(over: Partial<UsageRow>): UsageRow {
  return {
    day: "2026-08-26",
    agent: "claude",
    projectPath: "C:\\Work\\yard",
    model: "claude-opus-5",
    input: 100,
    output: 10,
    cacheRead: 50,
    cacheWrite: 5,
    costUsd: 1,
    sessions: 1,
    ...over,
  };
}

describe("bucketBy", () => {
  it("sums a day's rows into one bucket and keeps the days in calendar order", () => {
    const rows = [
      row({ day: "2026-08-26", costUsd: 2, input: 10 }),
      row({ day: "2026-08-25", costUsd: 1, input: 5 }),
      row({ day: "2026-08-26", costUsd: 3, input: 20, model: "claude-sonnet-5" }),
    ];
    const days = bucketBy(rows, "day");
    expect(days.map((b) => b.key)).toEqual(["2026-08-25", "2026-08-26"]);
    expect(days[1]).toMatchObject({ label: "26/08", costUsd: 5, input: 30, rows: 2, priced: true });
  });

  it("ranks projects by cost, unpriced ones last, and names them by folder", () => {
    const rows = [
      row({ projectPath: "C:\\Work\\yard", costUsd: 1 }),
      row({ projectPath: "/home/me/api/", costUsd: 4 }),
      row({ projectPath: "", costUsd: null, agent: "codex", model: "gpt-5.3-codex" }),
    ];
    const projects = bucketBy(rows, "project");
    expect(projects.map((b) => b.label)).toEqual(["api", "yard", "(sem projeto)"]);
    expect(projects[2].costUsd).toBeNull();
  });

  it("marks a bucket as partially priced when one of its rows has no estimate", () => {
    const rows = [
      row({ model: "claude-opus-5", costUsd: 2 }),
      row({ model: "gpt-5.3-codex", agent: "codex", costUsd: null }),
    ];
    const agents = bucketBy(rows, "agent");
    expect(agents.find((b) => b.key === "claude")).toMatchObject({ costUsd: 2, priced: true });
    expect(agents.find((b) => b.key === "codex")).toMatchObject({ costUsd: null, priced: false });
    // A bucket mixing priced and unpriced rows is a floor, and says so.
    const models = bucketBy(rows.map((r) => ({ ...r, model: "x" })), "model");
    expect(models[0]).toMatchObject({ costUsd: 2, priced: false });
  });
});

describe("totals", () => {
  it("adds every column, and the cost is a floor when a row had no price", () => {
    const t = totals([
      row({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5, sessions: 1 }),
      row({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: null, sessions: 2 }),
    ]);
    expect(t).toMatchObject({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      costUsd: 0.5,
      priced: false,
      sessions: 3,
      rows: 2,
    });
    expect(totals([]).costUsd).toBeNull();
  });
});

describe("filterRange / daySeries", () => {
  const now = new Date(2026, 7, 26, 15, 0, 0); // 26 Aug 2026, local

  it("keeps only the days inside the window, counted back from today", () => {
    const rows = [
      row({ day: "2026-08-26" }),
      row({ day: "2026-08-20" }),
      row({ day: "2026-08-19" }),
    ];
    expect(filterRange(rows, { days: 1, now }).map((r) => r.day)).toEqual(["2026-08-26"]);
    expect(filterRange(rows, { days: 7, now }).map((r) => r.day)).toEqual([
      "2026-08-26",
      "2026-08-20",
    ]);
  });

  it("gives one entry per day of the window, zeros where nothing happened", () => {
    const rows = [row({ day: "2026-08-24", costUsd: 2, input: 5, output: 1 })];
    const series = daySeries(rows, { days: 3, now });
    expect(series.map((d) => d.day)).toEqual(["2026-08-24", "2026-08-25", "2026-08-26"]);
    expect(series[0]).toMatchObject({ label: "24/08", costUsd: 2, tokens: 6 });
    expect(series[1]).toMatchObject({ costUsd: null, tokens: 0 });
  });

  it("stamps a local day the way the backend does", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(dayLabel("2026-01-05")).toBe("05/01");
  });
});

describe("formatting", () => {
  it("writes dollars the Brazilian way and never invents a price", () => {
    expect(formatUsd(12.345)).toBe("US$ 12,35");
    expect(formatUsd(0)).toBe("US$ 0,00");
    expect(formatUsd(0.004)).toBe("< US$ 0,01");
    expect(formatUsd(null)).toBe("—");
  });

  it("compacts token counts in thousands and millions", () => {
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(3_400)).toBe("3,4 mil");
    expect(formatTokens(12_000)).toBe("12 mil");
    expect(formatTokens(1_234_567)).toBe("1,2 mi");
    expect(formatTokens(150_000_000)).toBe("150 mi");
  });

  it("labels a project by its folder name on either separator", () => {
    expect(projectLabel("C:\\Work\\yard")).toBe("yard");
    expect(projectLabel("/home/me/app/")).toBe("app");
    expect(projectLabel("")).toBe("(sem projeto)");
  });
});
