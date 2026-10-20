/** Execute release checks in order and fail before running any later operation. */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runReleaseChecks(checks, { stdio = "inherit", cwd = process.cwd() } = {}) {
  const completed = [];
  for (const check of checks) {
    const outcome = await new Promise((resolve) => {
      const child = spawn(check.executable, check.args, { cwd, stdio, windowsHide: true, env: check.env,
        windowsVerbatimArguments: check.windowsVerbatimArguments ?? false });
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (outcome.code !== 0 || outcome.signal || outcome.error) {
      return { ok: false, completed, failed: { name: check.name, ...outcome } };
    }
    completed.push(check.name);
  }
  return { ok: true, completed };
}

/**
 * The release checks, in the order they run; nothing is spawned here. There is
 * no front-end build among them: tauri-action runs `beforeBuildCommand`
 * (`npm run build`) itself, so a build here was a bundle thrown away.
 */
export function releaseChecks({ npmCli, nativeExe }) {
  const npm = (name, args) => ({ name, executable: process.execPath, args: [npmCli, ...args] });
  const checks = [
    npm("TypeScript", ["run", "typecheck"]),
    npm("Frontend tests", ["test"]),
    npm("Dependency audit", ["audit", "--audit-level=moderate"]),
    { name: "Rust lint", executable: "cargo", args: ["clippy", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--", "-D", "warnings"] },
    { name: "Rust tests", executable: "cargo", args: ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib"] },
  ];
  if (nativeExe) checks.push({ name: "Native boot", executable: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), "smoke.mjs"), resolve(nativeExe)] });
  return checks;
}

export function validateRelease({ npmCli = process.env.npm_execpath, nativeExe, cwd, stdio } = {}) {
  if (!npmCli) throw new Error("Run release validation through npm run validate:release.");
  return runReleaseChecks(releaseChecks({ npmCli, nativeExe }), { cwd, stdio });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await validateRelease({ nativeExe: process.argv[2] });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
