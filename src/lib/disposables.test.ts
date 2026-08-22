import { describe, expect, it, vi } from "vitest";

import { AsyncDisposer } from "./disposables";

describe("AsyncDisposer", () => {
  it("disposes the registered resources exactly once", async () => {
    const dispose = vi.fn();
    const owner = new AsyncDisposer();

    await owner.add(Promise.resolve(dispose));
    owner.dispose();
    owner.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("immediately disposes a resource that arrived after unmount", async () => {
    const dispose = vi.fn();
    let resolve!: (value: () => void) => void;
    const pending = new Promise<() => void>((done) => {
      resolve = done;
    });
    const owner = new AsyncDisposer();

    const registered = owner.add(pending);
    owner.dispose();
    resolve(dispose);

    await expect(registered).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
