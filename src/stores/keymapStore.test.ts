/**
 * The keymap store: what the kv says at boot is the map, a change is written
 * back, and "reset" means the default comes back and the override goes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_KEYMAP } from "../lib/keymap";
import { setPrefsTransport } from "../lib/prefs";
import { useKeymap } from "./keymapStore";

const writes: [string, string][] = [];

beforeEach(() => {
  writes.length = 0;
  setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      writes.push([key, value]);
    },
  });
  useKeymap.getState().load({});
});

describe("keymapStore", () => {
  it("boots from the kv, ignoring junk", () => {
    useKeymap
      .getState()
      .load({ "keys.canvas": JSON.stringify({ "tool.pen": { key: "KeyB" }, nope: 1 }) });
    expect(useKeymap.getState().map["tool.pen"]).toEqual({ key: "KeyB" });
    expect(useKeymap.getState().map["tool.select"]).toEqual(DEFAULT_KEYMAP["tool.select"]);
    useKeymap.getState().load({ "keys.canvas": "{broken" });
    expect(useKeymap.getState().map["tool.pen"]).toEqual(DEFAULT_KEYMAP["tool.pen"]);
  });

  it("binding writes the override to the kv and updates the map", async () => {
    useKeymap.getState().bind("tool.flow", { key: "KeyQ" });
    expect(useKeymap.getState().map["tool.flow"]).toEqual({ key: "KeyQ" });
    await vi.waitFor(() => expect(writes.at(-1)?.[0]).toBe("keys.canvas"));
    expect(JSON.parse(writes.at(-1)![1])).toEqual({ "tool.flow": { key: "KeyQ" } });
  });

  it("reset drops the override and the default comes back", () => {
    useKeymap.getState().bind("tool.flow", null);
    expect(useKeymap.getState().map["tool.flow"]).toBeNull();
    useKeymap.getState().reset("tool.flow");
    expect(useKeymap.getState().map["tool.flow"]).toEqual(DEFAULT_KEYMAP["tool.flow"]);
    expect(useKeymap.getState().overrides).toEqual({});
  });
});
