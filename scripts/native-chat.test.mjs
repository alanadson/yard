/** Chat verification must use the same isolated native process boundary as task verification. */
import { expect, it } from "vitest";
import { runNativeChatCheck } from "./native-chat.mjs";

it("reports a native chat check process crash instead of passing without exercising the conversation", async () => {
  await expect(runNativeChatCheck(process.execPath, {
    args: ["-e", "process.exit(3)"], timeoutMs: 1000, keepFailureData: false,
  })).rejects.toThrow("Native process exited with code 3");
});
