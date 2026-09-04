/**
 * The NSIS installer build, with the updater signature decided **before** the
 * compiler starts.
 *
 * `bundle.createUpdaterArtifacts` is `true` and stays true (a Rust test in
 * `updater.rs` pins it): a release with no `.sig` is a release no installed
 * copy can ever update to. The consequence is that the bundler wants the
 * minisign private key on every build, and the key lives in a GitHub secret —
 * so a build run on a developer's machine used to compile for five minutes and
 * then die on the last line:
 *
 *     A public key has been found, but no private key. Make sure to set
 *     `TAURI_SIGNING_PRIVATE_KEY` environment variable.
 *
 * Here the key is looked for first. Found, the build is signed exactly as CI
 * signs it. Not found, the build drops the updater artifacts through
 * `--config`, prints why, and produces a perfectly good installer for local
 * use — one that says plainly it can never be published as an update.
 *
 *   node scripts/installer.mjs            # signs if it can, otherwise says so
 *
 * Where the key is looked for, in order: `TAURI_SIGNING_PRIVATE_KEY` in the
 * environment (the CI shape), `%YARD_UPDATER_KEY%` pointing at a file,
 * `<repo>\.tauri\yard-updater.key` (gitignored), then
 * `%USERPROFILE%\.tauri\yard-updater.key` — the path `docs/development.md`
 * tells you to generate it at.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** The key file candidates, most explicit first. */
export function keyFileCandidates(env = process.env, home = homedir(), repo = root) {
  return [
    env.YARD_UPDATER_KEY,
    join(repo, ".tauri", "yard-updater.key"),
    join(home, ".tauri", "yard-updater.key"),
  ].filter(Boolean);
}

/**
 * How the build has to run: signed with a key, or explicitly without updater
 * artifacts. Never the third case — started, minutes spent, then refused.
 *
 * Pure: `env` is the environment as it is, `keyFile` is `{ path, content }`
 * for the first candidate that existed, or `null`. The password is always
 * set, even to the empty string: with the variable absent minisign asks for
 * one on stdin and a scripted build hangs there.
 */
export function signingPlan({ env = {}, keyFile = null } = {}) {
  const inline = (env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim();
  if (inline) {
    return {
      signed: true,
      source: "environment",
      reason: "TAURI_SIGNING_PRIVATE_KEY is set: the updater artifacts will be signed.",
      args: [],
      env: {
        TAURI_SIGNING_PRIVATE_KEY: env.TAURI_SIGNING_PRIVATE_KEY,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
      },
    };
  }

  if (keyFile && keyFile.content.trim()) {
    return {
      signed: true,
      source: keyFile.path,
      reason: `updater key read from ${keyFile.path}: the artifacts will be signed.`,
      args: [],
      env: {
        TAURI_SIGNING_PRIVATE_KEY: keyFile.content,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
      },
    };
  }

  return {
    signed: false,
    source: null,
    reason:
      "no updater key found: building WITHOUT updater artifacts. The installer works, " +
      "but it is not signed and can never be published as an update — releases come " +
      "from the tag workflow, which holds the key.",
    args: ["--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } })],
    env: {},
  };
}

/** The first candidate that exists on disk, read. */
function findKeyFile(env = process.env) {
  for (const path of keyFileCandidates(env)) {
    if (existsSync(path)) return { path, content: readFileSync(path, "utf8") };
  }
  return null;
}

async function main() {
  const plan = signingPlan({ env: process.env, keyFile: findKeyFile() });
  console.log(`==> Installer (${plan.signed ? "signed" : "unsigned"})`);
  console.log(`    ${plan.reason}`);

  // The CLI is invoked through node, with no shell: `--config` carries raw
  // JSON, and node's shell escaping on Windows would mangle every quote in it.
  const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const child = spawn(process.execPath, [cli, "build", ...plan.args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...plan.env },
  });
  child.on("error", (e) => {
    console.error(`installer: could not start the tauri CLI (${e.message}). Run npm ci?`);
    process.exit(2);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

// Only when run as a script: the test imports the pure decision above.
if (process.argv[1] && process.argv[1].endsWith("installer.mjs")) {
  await main();
}
