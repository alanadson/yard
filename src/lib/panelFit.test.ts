/**
 * How much window is left for the work itself.
 *
 * Three panels can be open at once and together they claim 698 px of
 * minimums, while the window is allowed down to 900. Below the floor someone
 * has to give way, and `App.tsx` has always known the order (bench, changes,
 * sidebar — the inverse of priority). What it did not have was this
 * arithmetic in a place a test could reach, or anything on screen when it
 * acted: pressing Ctrl+Shift+B in a narrow window opened the bench, the
 * resize effect re-ran, and the bench — first in the yield order — closed
 * again. The panel blinked and the shortcut looked broken.
 *
 * The boundary is the whole point: the workspace floor is a minimum that is
 * still allowed, not the first width that fails.
 */
import { describe, expect, it } from "vitest";

import { fits, leftover } from "./panelFit";

describe("leftover", () => {
  it("hands the workspace whatever the open panels did not claim", () => {
    expect(leftover(1280, [190, 260])).toBe(830);
  });

  it("counts nothing for the panels that are shut", () => {
    expect(leftover(900, [])).toBe(900);
  });

  it("goes negative rather than clamping — the caller decides what that means", () => {
    expect(leftover(400, [190, 260, 248])).toBe(-298);
  });
});

describe("fits", () => {
  const WORKSPACE_MIN = 320;
  // SIDEBAR_MIN, CHANGES_MIN, BENCH_MIN as `uiStore` declares them.
  const ALL_THREE = [190, 260, 248];

  it("accepts the floor itself — a minimum is a width that still works", () => {
    // 320 + 698 = 1018, exactly.
    expect(fits(1018, ALL_THREE, WORKSPACE_MIN)).toBe(true);
  });

  it("refuses one pixel under the floor", () => {
    expect(fits(1017, ALL_THREE, WORKSPACE_MIN)).toBe(false);
  });

  it("the narrowest window the app allows cannot hold all three", () => {
    // The regression this locks: 900 is `minWidth` in tauri.conf.json, and
    // 900 - 698 = 202, well under the 320 the workspace needs.
    expect(fits(900, ALL_THREE, WORKSPACE_MIN)).toBe(false);
    // Dropping the bench is enough at that width.
    expect(fits(900, [190, 260], WORKSPACE_MIN)).toBe(true);
  });
});
