/** Diagnostics verification must fail if its isolated native process exits before the UI is ready. */
import { expect, it } from "vitest";
import { runNativeDiagnosticsCheck } from "./native-diagnostics.mjs";

it("reports an early process crash rather than passing agent diagnostics without a native window", async () => {
  await expect(runNativeDiagnosticsCheck(process.execPath, {
    args: ["-e", "process.exit(3)"], timeoutMs: 1000, keepFailureData: false,
  })).rejects.toThrow("Native process exited with code 3");
});
