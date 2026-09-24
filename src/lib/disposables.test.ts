// Async registrations must release native resources even when their owner has already left.
import { describe, expect, it, vi } from "vitest";

import { AsyncDisposer, ownRegistration } from "./disposables";

describe("AsyncDisposer", () => {
  it("releases a registration that finishes after its owner is disposed", async () => {
    let finish!: () => void;
    let active = false;
    const registered = new Promise<void>((resolve) => { finish = resolve; });
    const stop = ownRegistration(
      async () => { await registered; active = true; },
      async () => { active = false; },
    );
    stop();
    finish();
    await registered;
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(false);
  });

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
