/** Pipeline checks must surface failure of the owned native process before browser startup. */
import { expect, it } from "vitest";
import { runNativeLegacyFlowCheck } from "./native-legacy-flow.mjs";

it("fails the legacy pipeline check when its native process exits before browser startup", async () => {
  await expect(runNativeLegacyFlowCheck(process.execPath, { args: ["-e", "process.exit(7)"], timeoutMs: 1000, keepFailureData: false }))
    .rejects.toThrow("Native process exited with code 7");
});
