import { describe, expect, it, vi } from "vitest";

import { runBackground } from "./background";

describe("runBackground", () => {
  it("suppresses only a missing Tauri bridge", async () => {
    const error = vi.fn();
    runBackground(
      () => Promise.reject(new ReferenceError("window is not defined")),
      { error },
    );
    await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
  });

  it("reports real asynchronous failures", async () => {
    const error = vi.fn();
    runBackground(() => Promise.reject(new Error("disk full")), { error });
    await Promise.resolve();
    expect(error).toHaveBeenCalledOnce();
  });
});
