/** Packaged installation is verified only on disposable hosted Windows runners. */
import { runReleaseChecks } from "./release-validation.mjs";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runSmokeIn } from "./smoke.mjs";

export function requireHostedWindows(platform, env) {
  if (platform !== "win32" || env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Packaged installer checks require a disposable GitHub-hosted Windows runner.");
  }
}

export function installerEnvironment(parent) {
  const child = { ...parent };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) delete child[key];
  return child;
}

export async function seedLegacyInstallData(directory) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(directory, "app.db");
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 0;
      CREATE TABLE work_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
      criteria_json TEXT NOT NULL, links_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL, delivery_json TEXT)`);
    database.prepare("INSERT INTO kv VALUES (?, ?)").run("installer.preserved", "original-value");
    database.prepare("INSERT INTO work_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("installer-preserved-task", "Saved task", "Original saved request", "draft",
      JSON.stringify([{ id: "criterion-1", text: "Preserve existing work", evidence: [] }]), JSON.stringify({ projectId: null, terminalIds: [] }), 1000, 1000, 1);
  } finally { database.close(); }
  return path;
}

export async function verifyPreservedInstallData(directory) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(directory, "app.db"), { readOnly: true });
  try {
    if (database.prepare("PRAGMA user_version").get().user_version <= 0) throw new Error("Legacy data migration did not run");
    const task = database.prepare("SELECT request, criteria_json FROM work_tasks WHERE id = 'installer-preserved-task'").get();
    if (task?.request !== "Original saved request") throw new Error("The original task request was not preserved");
    if (JSON.parse(task.criteria_json)[0]?.text !== "Preserve existing work") throw new Error("The original acceptance criteria were not preserved");
    if (database.prepare("SELECT value FROM kv WHERE key = 'installer.preserved'").get()?.value !== "original-value") throw new Error("Existing preferences were not preserved");
  } finally { database.close(); }
}

export function nsisInstallJob(installer, directory) {
  if (!directory || /["\r\n\0]/.test(directory)) throw new Error("Invalid NSIS installation destination");
  // NSIS requires /D last and unquoted, including directories with spaces.
  return { executable: resolve(installer), args: ["/S", `/D=${directory}`], windowsVerbatimArguments: true };
}

export function verifyInstallerSequence(install, boot, replacement, options = {}) {
  return runReleaseChecks([
    { name: "Packaged install", ...install },
    { name: "Installed application boot", ...boot },
    { name: "Packaged replacement", ...replacement },
    { name: "Replaced application boot", ...boot },
  ], options);
}

async function main() {
  if (process.argv[2] === "--boot-data") {
    const verdict = await runSmokeIn(resolve(process.argv[3]), resolve(process.argv[4]));
    if (!verdict.ok) throw new Error("Installed application boot failed");
    await verifyPreservedInstallData(resolve(process.argv[4]));
    return;
  }
  requireHostedWindows(process.platform, process.env);
  const installer = process.argv[2] && resolve(process.argv[2]);
  const previous = process.argv[3] && resolve(process.argv[3]);
  if (!installer || !existsSync(installer) || (previous && !existsSync(previous))) throw new Error("Provide existing packaged installer artifacts");
  const directory = mkdtempSync(join(tmpdir(), "yard-packaged-install-"));
  const install = join(directory, "application");
  const data = join(directory, "data");
  mkdirSync(data);
  await seedLegacyInstallData(data);
  try {
    const environment = installerEnvironment(process.env);
    const result = await verifyInstallerSequence({ ...nsisInstallJob(previous ?? installer, install), env: environment },
      { executable: process.execPath, args: [fileURLToPath(import.meta.url), "--boot-data", join(install, "yard.exe"), data], env: environment },
      { ...nsisInstallJob(installer, install), env: environment });
    console.log(JSON.stringify({ ...result, baseline: previous ? "previous-release" : "same-package-reinstall" }));
    if (!result.ok) throw new Error(`Packaged installer verification failed: ${result.failed.name}`);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Refusing cleanup outside owned installer data");
    rmSync(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
