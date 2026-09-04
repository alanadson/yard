/**
 * Why these rules matter: `bundle.createUpdaterArtifacts` is `true` and pinned
 * by a Rust test — the release has to carry a `.sig`, or an installed copy can
 * never be updated. The price is that **every** build wants the minisign key,
 * including the one you run on your own machine to look at the installer. Left
 * alone, that build compiles for minutes and only then dies with "A public key
 * has been found, but no private key".
 *
 * So the decision comes first, before the compiler is even started: with a key
 * in hand the build stays signed; with no key it drops the updater artifacts
 * and says so. What must never happen is the third case — an installer that
 * *looks* releasable and carries no signature.
 */
import { describe, expect, it } from "vitest";

import { signingPlan } from "./installer.mjs";

const KEY = "untrusted comment: minisign encrypted secret key\nRWRTY0Iy...\n";

describe("signingPlan", () => {
  it("signs with the key already in the environment, and does not read any file", () => {
    const plan = signingPlan({
      env: { TAURI_SIGNING_PRIVATE_KEY: KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "hunter2" },
      keyFile: null,
    });
    expect(plan.signed).toBe(true);
    expect(plan.env.TAURI_SIGNING_PRIVATE_KEY).toBe(KEY);
    expect(plan.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("hunter2");
    expect(plan.args).toEqual([]);
  });

  it("signs with a key found on disk when the environment carries none", () => {
    const plan = signingPlan({
      env: {},
      keyFile: { path: "C:\\Users\\me\\.tauri\\yard-updater.key", content: KEY },
    });
    expect(plan.signed).toBe(true);
    expect(plan.env.TAURI_SIGNING_PRIVATE_KEY).toBe(KEY);
    expect(plan.source).toContain("yard-updater.key");
  });

  /**
   * The regression this locks down: with no password set, minisign asks for one
   * on stdin and a build launched from a script hangs there forever.
   */
  it("passes an empty password rather than none, so nothing prompts on stdin", () => {
    const plan = signingPlan({ env: {}, keyFile: { path: "k", content: KEY } });
    expect(plan.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("");
  });

  it("prefers the environment key over a leftover file on disk", () => {
    const plan = signingPlan({
      env: { TAURI_SIGNING_PRIVATE_KEY: KEY },
      keyFile: { path: "C:\\old.key", content: "an older key\n" },
    });
    expect(plan.env.TAURI_SIGNING_PRIVATE_KEY).toBe(KEY);
    expect(plan.source).toBe("environment");
  });

  it("turns the updater artifacts off when there is no key anywhere, instead of failing at the end", () => {
    const plan = signingPlan({ env: {}, keyFile: null });
    expect(plan.signed).toBe(false);
    expect(plan.env.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
    const override = JSON.parse(plan.args[plan.args.indexOf("--config") + 1]);
    expect(override.bundle.createUpdaterArtifacts).toBe(false);
  });

  /** An override that carried more than this would silently ship a different bundle. */
  it("changes nothing in the bundle but that one flag", () => {
    const plan = signingPlan({ env: {}, keyFile: null });
    expect(JSON.parse(plan.args[1])).toEqual({ bundle: { createUpdaterArtifacts: false } });
    expect(plan.args).toHaveLength(2);
  });

  it("says out loud that the unsigned installer can never become an update", () => {
    const plan = signingPlan({ env: {}, keyFile: null });
    expect(plan.reason.toLowerCase()).toContain("update");
  });

  /** A file that exists but is empty is not a key — treat it as absent. */
  it("does not take an empty key file for a key", () => {
    expect(signingPlan({ env: {}, keyFile: { path: "k", content: "   \n" } }).signed).toBe(false);
    expect(signingPlan({ env: { TAURI_SIGNING_PRIVATE_KEY: "" }, keyFile: null }).signed).toBe(false);
  });
});
