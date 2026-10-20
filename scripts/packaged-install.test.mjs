/** A failed packaged install must stop before any boot or replacement is attempted. */
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyInstallerSequence, requireHostedWindows, seedLegacyInstallData, verifyPreservedInstallData, nsisInstallJob, installerEnvironment } from "./packaged-install.mjs";

it("keeps installation children isolated from release credentials", () => {
  const parent = { PATH: "tool-path", GH_TOKEN: "github-secret", TAURI_SIGNING_PRIVATE_KEY: "signing-secret" };
  const child = installerEnvironment(parent);
  expect(child.PATH).toBe("tool-path");
  expect(child.GH_TOKEN).toBeUndefined();
  expect(child.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
  expect(parent.GH_TOKEN).toBe("github-secret");
});

it("refuses quotes that would change the NSIS installation destination", () => {
  expect(() => nsisInstallJob("installer.exe", 'C:/temporary/invalid"destination')).toThrow("destination");
});

it("requires migrated data and refuses an upgrade that replaced the saved request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-installer-rule-"));
  try {
    const path = await seedLegacyInstallData(directory);
    await expect(verifyPreservedInstallData(directory)).rejects.toThrow("migration");
    const { DatabaseSync } = await import("node:sqlite");
    const connection = new DatabaseSync(path);
    connection.exec("PRAGMA user_version = 9");
    connection.close();
    await expect(verifyPreservedInstallData(directory)).resolves.toBeUndefined();
    const changed = new DatabaseSync(path);
    changed.exec("UPDATE work_tasks SET request = 'Lost original request'");
    changed.close();
    await expect(verifyPreservedInstallData(directory)).rejects.toThrow("request");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("prepares a real legacy database with the original task request and criteria", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-installer-rule-"));
  try {
    const database = await seedLegacyInstallData(directory);
    const { DatabaseSync } = await import("node:sqlite");
    const connection = new DatabaseSync(database);
    try {
      const task = connection.prepare("SELECT request, criteria_json, links_json FROM work_tasks WHERE id = 'installer-preserved-task'").get();
      expect(task.request).toBe("Original saved request");
      expect(JSON.parse(task.criteria_json)[0].text).toBe("Preserve existing work");
      expect(JSON.parse(task.links_json)).toEqual({ projectId: null, terminalIds: [] });
    } finally { connection.close(); }
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses installer execution on a workstation or a self-hosted runner", () => {
  expect(() => requireHostedWindows("win32", {})).toThrow("disposable");
  expect(() => requireHostedWindows("win32", { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" })).toThrow("disposable");
  expect(() => requireHostedWindows("win32", { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" })).not.toThrow();
});

it("does not boot or replace an application after its installer fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-installer-rule-"));
  const fixture = join(directory, "fixture.cjs");
  writeFileSync(fixture, "require('node:fs').appendFileSync('calls.txt', process.argv[2] + '\\n'); process.exit(process.argv[2] === 'install' ? 7 : 0);");
  try {
    const job = (name) => ({ executable: process.execPath, args: [fixture, name] });
    const result = await verifyInstallerSequence(job("install"), job("boot"), job("replace"), { cwd: directory, stdio: "ignore" });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(directory, "calls.txt"), "utf8")).toBe("install\n");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
