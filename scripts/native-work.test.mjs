/** A native end-to-end check must fail on a real child crash before any browser interaction. */
import { expect, it } from "vitest";
import { ownsNativeBrowserProfile, runNativeWorkCheck } from "./native-work.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

it("releases only WebView processes belonging to the exact isolated profile", () => {
  const profile = "C:\\Temp\\yard-native-work-owned\\webview\\EBWebView";
  expect(ownsNativeBrowserProfile("msedgewebview2.exe", `webview --user-data-dir="${profile}" --type=gpu-process`, profile)).toBe(true);
  expect(ownsNativeBrowserProfile("msedgewebview2.exe", `webview --user-data-dir="${profile}-other"`, profile)).toBe(false);
  expect(ownsNativeBrowserProfile("node.exe", `node --user-data-dir="${profile}"`, profile)).toBe(false);
  expect(ownsNativeBrowserProfile("msedgewebview2.exe", `webview --note="${profile}"`, profile)).toBe(false);
});

it("reports an early native process failure and never treats it as a healthy browser check", async () => {
  await expect(runNativeWorkCheck(process.execPath, {
    args: ["-e", "process.exit(3)"], timeoutMs: 1000, keepFailureData: false,
  })).rejects.toThrow("Native process exited with code 3");
});

it("executes the native check from a repository path containing spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "yard-native-entry space-"));
  try {
    const source = dirname(fileURLToPath(import.meta.url));
    copyFileSync(join(source, "native-work.mjs"), join(root, "native-work.mjs"));
    copyFileSync(join(source, "smoke.mjs"), join(root, "smoke.mjs"));
    const result = spawnSync(process.execPath, [join(root, "native-work.mjs"), join(root, "missing.exe")], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Executable not found");
  } finally {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
