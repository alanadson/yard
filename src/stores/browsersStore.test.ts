/**
 * The kv gives back text written by an older build, by hand, or by nobody —
 * the parse has to make a browser tab out of it or drop it, never crash.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: { writePref: vi.fn(async () => undefined), readPrefs: vi.fn(async () => ({})) },
  on: vi.fn(async () => () => {}),
}));

import { parsePaneBrowsers } from "./browsersStore";

const row = (patch: Record<string, unknown> = {}) => ({
  id: "abc123",
  groupId: "g1",
  slot: 0,
  url: "http://localhost:5173/",
  ...patch,
});

describe("parsePaneBrowsers", () => {
  it("reads a full tab back", () => {
    const raw = JSON.stringify([
      row({
        slot: 2,
        title: "Yard",
        name: "Preview",
        storage: "workspace",
        muted: true,
        live: false,
        pinned: true,
      }),
    ]);
    expect(parsePaneBrowsers(raw)).toEqual([
      {
        id: "abc123",
        groupId: "g1",
        slot: 2,
        url: "http://localhost:5173/",
        title: "Yard",
        name: "Preview",
        ua: undefined,
        storage: "workspace",
        muted: true,
        live: false,
        pinned: true,
      },
    ]);
  });

  /**
   * A pinned page holds the front of its bar and survives "fechar as outras",
   * so it is worth nothing if the kv forgets it between sessions. `undefined`
   * for a loose tab, like `muted`: the kv stays free of `false` for every tab
   * nobody ever pinned.
   */
  it("remembers a pinned page, and leaves a loose one unmarked", () => {
    const raw = JSON.stringify([row({ id: "fixa", pinned: true }), row({ id: "solta" })]);
    const tabs = parsePaneBrowsers(raw);
    expect(tabs.find((t) => t.id === "fixa")?.pinned).toBe(true);
    expect(tabs.find((t) => t.id === "solta")?.pinned).toBeUndefined();
  });

  it("survives junk, and an empty kv", () => {
    expect(parsePaneBrowsers(undefined)).toEqual([]);
    expect(parsePaneBrowsers("")).toEqual([]);
    expect(parsePaneBrowsers("não é json")).toEqual([]);
    expect(parsePaneBrowsers('{"tabs":1}')).toEqual([]);
    expect(parsePaneBrowsers("[1, null, \"x\"]")).toEqual([]);
  });

  it("drops rows missing what a tab cannot live without", () => {
    const raw = JSON.stringify([
      row(),
      row({ id: "" }),
      row({ groupId: undefined }),
      row({ url: 42 }),
    ]);
    expect(parsePaneBrowsers(raw)).toHaveLength(1);
  });

  it("repairs fields of the wrong shape instead of trusting them", () => {
    const [tab] = parsePaneBrowsers(
      JSON.stringify([
        row({ slot: -3.7, storage: "outra-coisa", muted: "sim", title: 9 }),
      ]),
    );
    expect(tab.slot).toBe(0);
    expect(tab.storage).toBeUndefined();
    expect(tab.muted).toBeUndefined();
    expect(tab.title).toBeUndefined();
  });
});

