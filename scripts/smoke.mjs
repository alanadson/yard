/**
 * Boot smoke test: the real binary, an empty data directory, and the four
 * things that have to happen before anything else can.
 *
 * `docs/features.md` has always ended with an honest admission — "UI
 * interaction hasn't been exercised automatically, only the logic behind it".
 * Clicking is still not exercised here. What is, and what no unit test can
 * cover, is the path that breaks silently and takes the whole app with it: the
 * packaged binary starting, creating and migrating SQLite, bringing the agent
 * bridge up, and exiting without a panic.
 *
 * Deliberately not a UI driver. Yard has no WebDriver, and bringing one in
 * would mean a new dependency, a second CI shape and a class of flakiness the
 * suite has stayed free of. This is one process, one log and one verdict.
 *
 *   node scripts/smoke.mjs                    # uses target\debug\yard.exe
 *   node scripts/smoke.mjs path\to\yard.exe
 *
 * Exit code 0 = the boot is healthy. Anything else prints why.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

/**
 * What a healthy boot writes, in `%YARD_DATA_DIR%\logs`. Substrings, not
 * regexes: these are the app's own sentences (`logging.rs`,
 * `persistence/db.rs`, `bridge.rs`), and matching them loosely is what keeps
 * this from breaking every time a field is added to a log line.
 */
export const MARKERS = ["logging iniciado", "sqlite pronto", "bridge: escutando"];

/** Keep real agent configuration and active WebView profiles out of an isolated check. */
export function isolatedSmokeEnvironment(parent, dir) {
  const home = join(dir, "home");
  return { ...parent, YARD_DATA_DIR: dir, YARD_HOME_DIR: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview") };
}

/**
 * Pass or fail, and why.
 *
 * Strict in one direction only: a missing marker, a missing database, a
 * non-zero exit or a panic all fail; extra lines never do. A boot log grows
 * every release, and a smoke test that goes red for a new log line is one
 * that gets commented out within the month.
 */
export function bootVerdict(log, { dbExists, exitCode }) {
  const missing = MARKERS.filter((marker) => !log.includes(marker));
  const reasons = [];
  for (const marker of missing) reasons.push(`o log nunca disse "${marker}"`);
  if (!dbExists) reasons.push("o app.db não foi criado");
  if (exitCode !== 0) reasons.push(`o processo saiu com código ${exitCode}`);
  if (/panicked at/i.test(log)) reasons.push("houve um panic no log");
  if (/failed to create webview/i.test(log)) reasons.push("native WebView creation failed");
  return { ok: reasons.length === 0, missing, reasons };
}

/** Everything under a folder, concatenated — the app rotates its log by day. */
function readLogs(dir) {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .sort()
    .map((name) => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(exe, args = []) {
  // Process fixtures and real boot checks share the same isolated data boundary.
  const dir = mkdtempSync(join(tmpdir(), "yard-smoke-"));
  try { return await runSmokeIn(exe, dir, args); }
  finally {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch { /* The native profile may still be releasing its files. */ }
  }
}

export async function runSmokeIn(exe, dir, args = []) {
  const scope = relative(tmpdir(), dir);
  if (!scope || scope.startsWith("..") || isAbsolute(scope)) throw new Error("Native smoke data must stay inside an owned temporary directory");
  console.log(`smoke: ${exe}\nsmoke: dados em ${dir}`);
  const previousLog = readLogs(join(dir, "logs"));
  const currentLog = () => {
    const log = readLogs(join(dir, "logs"));
    return previousLog && log.startsWith(previousLog) ? log.slice(previousLog.length) : log;
  };

  const child = spawn(exe, args, {
    env: isolatedSmokeEnvironment(process.env, dir),
    stdio: "ignore",
    windowsHide: true,
  });
  let exitCode = null;
  let signal = null;
  let terminatedByHarness = false;
  child.on("error", () => { exitCode = -1; });
  child.on("exit", (code, exitSignal) => {
    exitCode = code ?? -1;
    signal = exitSignal;
  });

  // Wait for the markers rather than for a fixed time: a debug build on a
  // cold cache takes seconds, a warm release build takes a moment.
  const deadline = Date.now() + 60_000;
  let log = "";
  while (Date.now() < deadline) {
    await sleep(500);
    log = currentLog();
    if (MARKERS.every((m) => log.includes(m))) break;
    if (exitCode !== null) break;
  }

  const dbExists = existsSync(join(dir, "app.db"));

  // Ask it to go, then insist. The exit path is part of what is being tested:
  // an app that has to be killed is an app that leaks child processes.
  if (exitCode === null) {
    terminatedByHarness = true;
    child.kill();
    for (let i = 0; i < 20 && exitCode === null; i++) await sleep(250);
    if (exitCode === null) {
      child.kill("SIGKILL");
      await sleep(500);
    }
  }
  log = currentLog();

  // Only a signal sent by this harness is an expected end to a healthy run.
  const expectedSignal = terminatedByHarness && ["SIGTERM", "SIGKILL"].includes(signal);
  const verdict = bootVerdict(log, { dbExists, exitCode: expectedSignal ? 0 : exitCode });
  if (verdict.ok) {
    console.log("smoke: boot saudável (log, sqlite, ponte, sem panic).");
  } else {
    console.error("smoke: FALHOU");
    for (const reason of verdict.reasons) console.error(`  - ${reason}`);
  }
  return verdict;
}

async function main() {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) {
    console.error(`smoke: executable not found: ${exe}. Build first or pass its path.`);
    process.exit(2);
  }
  const verdict = await runSmoke(exe);
  process.exit(verdict.ok ? 0 : 1);
}

// Only when run as a script: the test imports the two pure exports above.
if (process.argv[1] && process.argv[1].endsWith("smoke.mjs")) {
  main().catch((e) => {
    console.error(`smoke: ${e}`);
    process.exit(2);
  });
}
