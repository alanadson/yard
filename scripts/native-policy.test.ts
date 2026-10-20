/** Scheduling checks must fail when the owned native process exits before browser startup. */
import { expect, it } from "vitest";
import { runNativePolicyCheck } from "./native-policy.mjs";

it("fails the policy check when the native process exits before its browser is available", async () => {
  await expect(runNativePolicyCheck(process.execPath, { args: ["-e", "process.exit(7)"], timeoutMs: 1000, keepFailureData: false }))
    .rejects.toThrow("Native process exited with code 7");
});
