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

import { MARKERS, bootVerdict, isolatedSmokeEnvironment, runSmoke, runSmokeIn } from "./smoke.mjs";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const healthy = [
  "2026-08-28T04:00:00Z INFO logging iniciado dir=C:\tmp\yard-smoke\logs",
  "2026-08-28T04:00:01Z INFO sqlite pronto path=C:\tmp\yard-smoke\app.db",
  "2026-08-28T04:00:01Z INFO bridge: escutando pipe=\\.\pipe\yard-bridge-abc",
].join("\n");

describe("bootVerdict", () => {
  it("does not reuse the previous boot's healthy markers when the replacement never starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "yard-smoke-owned-"));
    mkdirSync(join(directory, "logs"));
    writeFileSync(join(directory, "logs", "fixture.log"), healthy);
    writeFileSync(join(directory, "app.db"), "original database");
    try {
      expect((await runSmokeIn(process.execPath, directory, ["-e", "process.exit(0)"])).ok).toBe(false);
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps caller-owned saved data after checking a real process boot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "yard-smoke-owned-"));
    writeFileSync(join(directory, "app.db"), "original database");
    const script = `const fs = require('node:fs'); const path = require('node:path');
      const root = process.env.YARD_DATA_DIR;
      fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'logs', 'fixture.log'), ${JSON.stringify(healthy)});
      setInterval(() => {}, 1000);`;
    try {
      expect((await runSmokeIn(process.execPath, directory, ["-e", script])).ok).toBe(true);
      expect(readFileSync(join(directory, "app.db"), "utf8")).toBe("original database");
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("reports a real child failure even after all boot markers were written", async () => {
    const script = `const fs = require('node:fs'); const path = require('node:path');
      const root = process.env.YARD_DATA_DIR;
      fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'app.db'), 'fixture');
      fs.writeFileSync(path.join(root, 'logs', 'fixture.log'), ${JSON.stringify(healthy)});
      process.exit(3);`;
    const verdict = await runSmoke(process.execPath, ["-e", script]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("3");
  });
  it("isolates native browser and agent configuration without changing the parent process", () => {
    const parent = { PATH: "tool-path", CODEX_HOME: "real-codex", CLAUDE_CONFIG_DIR: "real-claude" };
    const child = isolatedSmokeEnvironment(parent, "test-data");
    expect(child.YARD_DATA_DIR).toBe("test-data");
    expect(child.YARD_HOME_DIR).toBe(join("test-data", "home"));
    expect(child.CODEX_HOME).toBe(join("test-data", "home", ".codex"));
    expect(child.CLAUDE_CONFIG_DIR).toBe(join("test-data", "home", ".claude"));
    expect(child.WEBVIEW2_USER_DATA_FOLDER).toBe(join("test-data", "webview"));
    expect(child.PATH).toBe("tool-path");
    expect(parent.CODEX_HOME).toBe("real-codex");
  });
  it("fails when the native webview cannot be created even if services started", () => {
    const log = `${healthy}\nERROR tauri_runtime_wry: failed to create webview: WebView2 error`;
    expect(bootVerdict(log, { dbExists: true, exitCode: 0 }).ok).toBe(false);
  });
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
