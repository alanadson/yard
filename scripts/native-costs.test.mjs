/** Cost verification must fail if its isolated native process ends before displaying estimates. */
import { expect, it } from "vitest";
import { runNativeCostsCheck } from "./native-costs.mjs";

it("reports an early native process crash instead of passing costs without reading a session", async () => {
  await expect(runNativeCostsCheck(process.execPath, {
    args: ["-e", "process.exit(3)"], timeoutMs: 1000, keepFailureData: false,
  })).rejects.toThrow("Native process exited with code 3");
});
