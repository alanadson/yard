/** A native automation check must report a real process crash instead of a green renderer assertion. */
import { expect, it } from "vitest";
import { runNativeSchedulerCheck } from "./native-scheduler.mjs";

it("fails the automation check when the native process exits before its browser is available", async () => {
  await expect(runNativeSchedulerCheck(process.execPath, { args: ["-e", "process.exit(7)"], timeoutMs: 1000, keepFailureData: false }))
    .rejects.toThrow("Native process exited with code 7");
});
