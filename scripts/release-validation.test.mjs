/** Release validation must stop before later tooling runs when a real child fails. */
import { expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { releaseChecks, runReleaseChecks, validateRelease } from "./release-validation.mjs";

it("passes an isolated data destination to the actual child process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-release-check-"));
  const fixture = join(directory, "fixture.cjs");
  writeFileSync(fixture, "require('node:fs').writeFileSync('destination.txt', process.env.YARD_INSTALL_DATA_DIR || 'missing');");
  try {
    await runReleaseChecks([{ name: "Isolated child", executable: process.execPath, args: [fixture], env: { ...process.env, YARD_INSTALL_DATA_DIR: "owned-install-data" } }], { cwd: directory, stdio: "ignore" });
    expect(readFileSync(join(directory, "destination.txt"), "utf8")).toBe("owned-install-data");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("stops at a real failed check without running the next release operation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-release-check-"));
  const marker = join(directory, "should-not-exist");
  try {
    const result = await runReleaseChecks([
      { name: "Failed validation", executable: process.execPath, args: ["-e", "process.exit(7)"] },
      { name: "Later release operation", executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker] },
    ], { stdio: "ignore" });
    expect(result).toEqual({ ok: false, completed: [], failed: { name: "Failed validation", code: 7, signal: null } });
    expect(existsSync(marker)).toBe(false);
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("runs the normal release validations and stops before native tooling when frontend tests fail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-release-check-"));
  const fakeNpm = join(directory, "npm.cjs");
  writeFileSync(fakeNpm, "const fs = require('node:fs'); fs.appendFileSync('calls.txt', process.argv.slice(2).join(' ') + '\\n'); process.exit(process.argv[2] === 'test' ? 7 : 0);");
  try {
    const result = await validateRelease({ npmCli: fakeNpm, cwd: directory, stdio: "ignore" });
    expect(result).toEqual({ ok: false, completed: ["TypeScript"], failed: { name: "Frontend tests", code: 7, signal: null } });
    expect(readFileSync(join(directory, "calls.txt"), "utf8")).toBe("run typecheck\ntest\n");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The regression this locks down: the release job built the front-end twice,
 * once here and again in tauri-action's `beforeBuildCommand` (`npm run build`),
 * and the first bundle was thrown away. The typecheck stays, the build does not.
 */
it("leaves the front-end build to tauri-action, whose beforeBuildCommand already runs it", () => {
  const checks = releaseChecks({ npmCli: "npm-cli.js" });
  expect(checks.filter((check) => check.args.includes("build")).map((check) => check.name)).toEqual([]);
  expect(checks.map((check) => check.name)).toEqual(["TypeScript", "Frontend tests", "Dependency audit", "Rust lint", "Rust tests"]);
});

it("stops before the Rust checks when dependency auditing reports an unsafe release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-release-check-"));
  const fakeNpm = join(directory, "npm.cjs");
  writeFileSync(fakeNpm, "const fs = require('node:fs'); fs.appendFileSync('calls.txt', process.argv.slice(2).join(' ') + '\\n'); process.exit(process.argv[2] === 'audit' ? 7 : 0);");
  try {
    const result = await validateRelease({ npmCli: fakeNpm, cwd: directory, stdio: "ignore" });
    expect(result).toEqual({ ok: false, completed: ["TypeScript", "Frontend tests"], failed: { name: "Dependency audit", code: 7, signal: null } });
    expect(readFileSync(join(directory, "calls.txt"), "utf8")).toBe("run typecheck\ntest\naudit --audit-level=moderate\n");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
