/**
 * Why these rules matter: `features.md` admits that UI interaction "hasn't
 * been exercised automatically — only the logic behind it". This harness does
 * not click anything either, but it does cover the one path no unit test can:
 * the real binary starting, opening SQLite, listening on the bridge and
 * shutting down without leaving anything behind.
 *
 * The verdict has to be strict in one direction only. A missing marker is a
 * failure; an *extra* line is not. A boot log grows every release, and a
 * smoke test that goes red because someone added a log line is a smoke test
 * that gets commented out.
 */
import { describe, expect, it } from "vitest";

import { MARKERS, bootVerdict } from "./smoke.mjs";

const healthy = [
  "2026-08-28T04:00:00Z INFO logging iniciado dir=C:\tmp\yard-smoke\logs",
  "2026-08-28T04:00:01Z INFO sqlite pronto path=C:\tmp\yard-smoke\app.db",
  "2026-08-28T04:00:01Z INFO bridge: escutando pipe=\\.\pipe\yard-bridge-abc",
].join("\n");

describe("bootVerdict", () => {
  it("passes a boot that logged everything it has to log", () => {
    const v = bootVerdict(healthy, { dbExists: true, exitCode: 0 });
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it("names exactly what was missing, so the failure is readable", () => {
    const v = bootVerdict("INFO logging iniciado", { dbExists: true, exitCode: 0 });
    expect(v.ok).toBe(false);
    expect(v.missing).toContain("sqlite pronto");
    expect(v.missing).toContain("bridge: escutando");
  });

  /** A log line about the database is not the same as a database. */
  it("fails when the database was never written, whatever the log says", () => {
    expect(bootVerdict(healthy, { dbExists: false, exitCode: 0 }).ok).toBe(false);
  });

  it("fails on a non-zero exit, even with a perfect log", () => {
    const v = bootVerdict(healthy, { dbExists: true, exitCode: 3 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("3");
  });

  it("does not mind extra lines — a log grows every release", () => {
    const noisy = `${healthy}\nINFO alguma coisa nova`;
    expect(bootVerdict(noisy, { dbExists: true, exitCode: 0 }).ok).toBe(true);
  });

  /** A panic in the log is a failure even when every marker is present. */
  it("fails when the log carries a panic", () => {
    const panicked = `${healthy}\nthread 'main' panicked at src/lib.rs:1`;
    const v = bootVerdict(panicked, { dbExists: true, exitCode: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ").toLowerCase()).toContain("panic");
  });

  it("keeps the marker list in one place, so the runner and the test agree", () => {
    expect(MARKERS).toContain("sqlite pronto");
  });
});
