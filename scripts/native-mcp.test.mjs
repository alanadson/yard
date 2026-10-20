/** MCP interface checks must refuse a child crash before they can inspect any configuration. */
import { expect, it } from "vitest";
import { runNativeMcpCheck } from "./native-mcp.mjs";

it("reports a real early process failure instead of accepting an MCP check", async () => {
  await expect(runNativeMcpCheck(process.execPath, {
    args: ["-e", "process.exit(3)"], timeoutMs: 1000, keepFailureData: false,
  })).rejects.toThrow("Native process exited with code 3");
});
