// A failed bridge registration must be reported without an unhandled rejection.
import { expect, it, vi } from "vitest";
import { on } from "./ipc";
import { startBridge } from "./bridgeListener";

it("reports a bridge listener registration failure to its owner", async () => {
  const error = new Error("bridge unavailable");
  const registration = vi.spyOn(on, "bridgeRequest").mockRejectedValue(error);
  const errors: unknown[] = [];
  const stop = startBridge((failure) => errors.push(failure));
  try {
    await vi.waitFor(() => expect(errors).toEqual([error]));
  } finally {
    stop();
    registration.mockRestore();
  }
});
