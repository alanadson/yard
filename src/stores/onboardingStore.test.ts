/**
 * The welcome sheet is decided from two things that arrive at different
 * moments — the kv snapshot and the workspace — and must fire at most once
 * per install: `load` runs again mid-session to recover from a snapshot the
 * backend refused, and a `loaded` that flips twice must not greet twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setPrefsTransport } from "../lib/prefs";
import { KV_ONBOARDING } from "../lib/onboarding";
import { useOnboarding } from "./onboardingStore";

const writes: [string, string][] = [];

beforeEach(() => {
  writes.length = 0;
  setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      writes.push([key, value]);
    },
  });
  useOnboarding.setState({ done: false, loaded: false, shown: false });
});

describe("useOnboarding", () => {
  it("shows once to a fresh install and then stays quiet for the rest of the session", () => {
    useOnboarding.getState().load({});
    expect(useOnboarding.getState().decide(0)).toBe("show");
    // The workspace reloads (a refused snapshot): still zero projects, key not
    // yet written — but the sheet is already up or was already dismissed.
    expect(useOnboarding.getState().decide(0)).toBe("done");
  });

  it("adopts an install that already had projects, writing the key without opening anything", () => {
    useOnboarding.getState().load({});
    expect(useOnboarding.getState().decide(3)).toBe("adopt");
    expect(writes).toEqual([[KV_ONBOARDING, "1"]]);
    expect(useOnboarding.getState().done).toBe(true);
  });

  it("reads the key from the boot snapshot and never shows again", () => {
    useOnboarding.getState().load({ [KV_ONBOARDING]: "1" });
    expect(useOnboarding.getState().done).toBe(true);
    expect(useOnboarding.getState().decide(0)).toBe("done");
    expect(writes).toEqual([]);
  });

  it("markDone persists the key exactly once — closing the sheet twice is one write", () => {
    useOnboarding.getState().load({});
    useOnboarding.getState().decide(0);
    useOnboarding.getState().markDone();
    useOnboarding.getState().markDone();
    expect(writes).toEqual([[KV_ONBOARDING, "1"]]);
    expect(useOnboarding.getState().done).toBe(true);
  });

  it("does not decide before the kv snapshot arrived — the workspace may load first", () => {
    expect(useOnboarding.getState().decide(0)).toBe("done");
    expect(useOnboarding.getState().shown).toBe(false);
    useOnboarding.getState().load({});
    expect(useOnboarding.getState().decide(0)).toBe("show");
  });

  it("is inert when writing fails: the sheet still closes and the session remembers", () => {
    const warn = vi.fn();
    setPrefsTransport({
      readPrefs: async () => ({}),
      writePref: async () => {
        throw new Error("disk");
      },
    });
    useOnboarding.getState().load({});
    useOnboarding.getState().markDone(warn);
    expect(useOnboarding.getState().done).toBe(true);
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
