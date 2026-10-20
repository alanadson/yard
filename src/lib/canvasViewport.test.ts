/**
 * Every pan or zoom used to rewrite the board's whole `layoutJson` (strokes
 * and all) and save the whole workspace, 500 ms after the gesture ended. The
 * camera is not content: it now lives in one small kv row per board, and the
 * layout keeps the value it had as the fallback (a board cloned elsewhere, a
 * kv row lost, an older data folder). Content saves are untouched, so no
 * stroke or note depends on this path.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_VIEWPORT } from "./canvas";
import { createViewportMemory, parseViewport, VIEWPORT_PREF_PREFIX } from "./canvasViewport";

describe("createViewportMemory", () => {
  it("prefers the camera remembered for a board over the one stored in its layout", () => {
    const memory = createViewportMemory(() => {});
    memory.remember("g1", { x: 10, y: 20, zoom: 1.5 });
    expect(memory.viewportOf("g1", { x: 0, y: 0, zoom: 0.5 })).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it("falls back to the layout's camera, and to the default when there is none", () => {
    const memory = createViewportMemory(() => {});
    expect(memory.viewportOf("g1", { x: 3, y: 4, zoom: 2 })).toEqual({ x: 3, y: 4, zoom: 2 });
    expect(memory.viewportOf("g2", undefined)).toEqual(DEFAULT_VIEWPORT);
  });

  it("persists a camera as one small kv row of its own board", () => {
    const writes: [string, string][] = [];
    const memory = createViewportMemory((key, value) => writes.push([key, value]));
    memory.remember("g1", { x: 10.123456, y: -20, zoom: 1.5 });
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(`${VIEWPORT_PREF_PREFIX}g1`);
    expect(parseViewport(writes[0][1])).toEqual({ x: 10.12, y: -20, zoom: 1.5 });
  });

  // Content commits remember the camera too (so the row is never older than
  // the layout's copy); a commit with the camera still must not write.
  it("does not write the row again when the camera did not move", () => {
    const writes: string[] = [];
    const memory = createViewportMemory((key) => writes.push(key));
    memory.remember("g1", { x: 1, y: 2, zoom: 1 });
    memory.remember("g1", { x: 1, y: 2, zoom: 1 });
    memory.remember("g1", { x: 1.001, y: 2, zoom: 1 });
    expect(writes).toHaveLength(1);
  });

  it("comes back from the boot prefs, ignoring rows it cannot trust", () => {
    const memory = createViewportMemory(() => {});
    memory.seed({
      [`${VIEWPORT_PREF_PREFIX}good`]: JSON.stringify({ x: 1, y: 2, zoom: 1 }),
      [`${VIEWPORT_PREF_PREFIX}broken`]: "{not json",
      [`${VIEWPORT_PREF_PREFIX}nan`]: JSON.stringify({ x: null, y: 2, zoom: 1 }),
      [`${VIEWPORT_PREF_PREFIX}flat`]: JSON.stringify({ x: 1, y: 2, zoom: 0 }),
      "ui.theme": "dark",
    });
    const layout = { x: 7, y: 7, zoom: 1 };
    expect(memory.viewportOf("good", layout)).toEqual({ x: 1, y: 2, zoom: 1 });
    expect(memory.viewportOf("broken", layout)).toEqual(layout);
    expect(memory.viewportOf("nan", layout)).toEqual(layout);
    expect(memory.viewportOf("flat", layout)).toEqual(layout);
  });
});
