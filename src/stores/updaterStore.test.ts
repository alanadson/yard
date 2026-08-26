/**
 * The store is the one place that talks to the updater plugin, and the plugin
 * is a process boundary (it fetches, verifies and runs an installer). What is
 * locked here is the behaviour around it: a check that finds nothing, one
 * that finds an ignored version, a download whose progress reaches the
 * screen, and the kv rows that make "ignore" and "last check" survive a
 * reload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  check: vi.fn<() => Promise<unknown>>(async () => null),
  relaunch: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));

import { setPrefsTransport } from "../lib/prefs";
import { KV_LAST_CHECK, KV_SKIP } from "../lib/updater";
import { useUpdater } from "./updaterStore";

function fakeUpdate(version: string, body?: string) {
  return {
    available: true,
    currentVersion: "0.1.0",
    version,
    body,
    downloadAndInstall: vi.fn(
      async (onEvent?: (e: { event: string; data?: Record<string, number> }) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 1000 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 400 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 600 } });
        onEvent?.({ event: "Finished" });
      },
    ),
    close: vi.fn(async () => undefined),
  };
}

let written: Record<string, string> = {};

beforeEach(() => {
  written = {};
  setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      written[key] = value;
    },
  });
  plugin.check.mockReset();
  plugin.check.mockResolvedValue(null);
  plugin.relaunch.mockClear();
  useUpdater.getState().reset();
});

describe("useUpdater.check", () => {
  it("finding nothing lands on 'none' and stamps the last check in kv", async () => {
    await useUpdater.getState().check({ manual: false, now: 5_000 });
    expect(useUpdater.getState().phase).toBe("none");
    expect(useUpdater.getState().lastCheckAt).toBe(5_000);
    expect(written[KV_LAST_CHECK]).toBe("5000");
  });

  it("an available version becomes an offer, with the notes summarized", async () => {
    plugin.check.mockResolvedValue(fakeUpdate("0.3.0", "- Bandeja\n- Tema claro"));
    await useUpdater.getState().check({ manual: false, now: 1 });
    const s = useUpdater.getState();
    expect(s.phase).toBe("available");
    expect(s.version).toBe("0.3.0");
    expect(s.notes).toEqual(["Bandeja", "Tema claro"]);
  });

  it("the version the user ignored stays quiet on an automatic check, and shows on a manual one", async () => {
    useUpdater.getState().load({ [KV_SKIP]: "0.3.0" });
    plugin.check.mockResolvedValue(fakeUpdate("0.3.0"));
    await useUpdater.getState().check({ manual: false, now: 1 });
    expect(useUpdater.getState().phase).toBe("none");
    await useUpdater.getState().check({ manual: true, now: 2 });
    expect(useUpdater.getState().phase).toBe("available");
  });

  it("a failed check is an error phase with the message, never a thrown promise", async () => {
    plugin.check.mockRejectedValue(new Error("offline"));
    await expect(useUpdater.getState().check({ manual: false, now: 1 })).resolves.toBeUndefined();
    expect(useUpdater.getState().phase).toBe("error");
    expect(useUpdater.getState().error).toContain("offline");
  });

  it("a second check while one is running is ignored", async () => {
    let release: (v: unknown) => void = () => {};
    plugin.check.mockReturnValue(new Promise((r) => (release = r)));
    const first = useUpdater.getState().check({ manual: false, now: 1 });
    // The second caller gets the check already in flight, not a new one.
    const second = useUpdater.getState().check({ manual: true, now: 2 });
    // The plugin call sits behind an `await` inside the store; give it the
    // microtasks it needs before looking.
    await new Promise((r) => setTimeout(r, 0));
    expect(plugin.check).toHaveBeenCalledTimes(1);
    release(null);
    await Promise.all([first, second]);
    expect(plugin.check).toHaveBeenCalledTimes(1);
    expect(useUpdater.getState().phase).toBe("none");
  });
});

describe("useUpdater.install", () => {
  it("reports download progress, then installs and relaunches", async () => {
    const update = fakeUpdate("0.3.0");
    plugin.check.mockResolvedValue(update);
    await useUpdater.getState().check({ manual: true, now: 1 });
    const seen: number[] = [];
    const unsub = useUpdater.subscribe((s) => seen.push(s.progress.downloaded));
    await useUpdater.getState().install();
    unsub();
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(seen).toContain(400);
    expect(seen).toContain(1000);
    expect(useUpdater.getState().progress.total).toBe(1000);
    expect(plugin.relaunch).toHaveBeenCalledTimes(1);
  });

  it("a download that fails goes back to the offer with the error, and does not relaunch", async () => {
    const update = fakeUpdate("0.3.0");
    update.downloadAndInstall.mockRejectedValue(new Error("disk full"));
    plugin.check.mockResolvedValue(update);
    await useUpdater.getState().check({ manual: true, now: 1 });
    await useUpdater.getState().install();
    expect(useUpdater.getState().phase).toBe("available");
    expect(useUpdater.getState().error).toContain("disk full");
    expect(plugin.relaunch).not.toHaveBeenCalled();
  });

  it("installing with no offer on the table does nothing", async () => {
    await useUpdater.getState().install();
    expect(plugin.relaunch).not.toHaveBeenCalled();
    expect(useUpdater.getState().phase).toBe("idle");
  });
});

describe("useUpdater.skip", () => {
  it("writes the ignored version to kv and clears the offer", async () => {
    plugin.check.mockResolvedValue(fakeUpdate("0.3.0"));
    await useUpdater.getState().check({ manual: false, now: 1 });
    useUpdater.getState().skip();
    expect(written[KV_SKIP]).toBe("0.3.0");
    expect(useUpdater.getState().phase).toBe("none");
    expect(useUpdater.getState().skipVersion).toBe("0.3.0");
  });
});

describe("useUpdater.load", () => {
  it("reads the last check and the ignored version from the kv snapshot", () => {
    useUpdater.getState().load({ [KV_LAST_CHECK]: "12345", [KV_SKIP]: "0.2.0" });
    expect(useUpdater.getState().lastCheckAt).toBe(12_345);
    expect(useUpdater.getState().skipVersion).toBe("0.2.0");
  });

  it("an unreadable stamp counts as never checked", () => {
    useUpdater.getState().load({ [KV_LAST_CHECK]: "yesterday" });
    expect(useUpdater.getState().lastCheckAt).toBe(0);
  });
});
