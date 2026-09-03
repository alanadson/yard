/**
 * The portals' shared memory: what the kv held at boot is what the cards
 * see, a visit and a star are written back, and junk in the kv is dropped
 * instead of crashing the boot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setPrefsTransport } from "../lib/prefs";
import { usePortalWeb } from "./portalWebStore";

const writes: [string, string][] = [];

beforeEach(() => {
  writes.length = 0;
  setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      writes.push([key, value]);
    },
  });
  usePortalWeb.getState().load({});
});

describe("portalWebStore", () => {
  it("boots from the kv, junk and all", () => {
    usePortalWeb.getState().load({
      "portal.history": JSON.stringify([{ url: "https://a.dev", lastAt: 5, count: 2 }, 7]),
      "portal.bookmarks": "{broken",
    });
    expect(usePortalWeb.getState().history).toEqual([{ url: "https://a.dev", lastAt: 5, count: 2 }]);
    expect(usePortalWeb.getState().bookmarks).toEqual([]);
  });

  it("a visit lands at the front and in the kv", async () => {
    usePortalWeb.getState().visited("https://b.dev", 10);
    expect(usePortalWeb.getState().history[0]).toEqual({ url: "https://b.dev", lastAt: 10, count: 1 });
    await vi.waitFor(() => expect(writes.some(([k]) => k === "portal.history")).toBe(true));
  });

  it("a star toggles and is written back", async () => {
    usePortalWeb.getState().toggleBookmark({ url: "https://b.dev", name: "B" });
    expect(usePortalWeb.getState().bookmarks).toEqual([{ url: "https://b.dev", name: "B" }]);
    await vi.waitFor(() => expect(writes.some(([k]) => k === "portal.bookmarks")).toBe(true));
    usePortalWeb.getState().toggleBookmark({ url: "https://b.dev", name: "B" });
    expect(usePortalWeb.getState().bookmarks).toEqual([]);
  });
});
