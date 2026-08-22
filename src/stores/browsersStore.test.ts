/**
 * The kv gives back text written by an older build, by hand, or by nobody —
 * the parse has to make a browser tab out of it or drop it, never crash.
 */
import { describe, expect, it } from "vitest";

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
      row({ slot: 2, title: "Yard", name: "Preview", storage: "workspace", muted: true, live: false }),
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
      },
    ]);
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
