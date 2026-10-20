/** Rendering validation must fail if its native child dies before any browser interaction. */
import { expect, it } from "vitest";
import { runNativeRenderingCheck } from "./native-rendering.mjs";

it("refuses an early process failure instead of accepting a healthy rendering check", async () => {
  await expect(runNativeRenderingCheck(process.execPath, {
    args: ["-e", "process.exit(3)"], timeoutMs: 1000, keepFailureData: false,
  })).rejects.toThrow("Native process exited with code 3");
});
