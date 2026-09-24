/** Secondary-button drags pan, while a stationary secondary click keeps the menu. */
import { expect, it } from "vitest";
import { backgroundPan, suppressPanMenu } from "./canvasPan";

it("keeps right click menus but suppresses them after dragging away and back", () => {
  expect(suppressPanMenu(2, 0, 0, false)).toBe(false);
  expect(suppressPanMenu(2, 8, 0, false)).toBe(true);
  expect(suppressPanMenu(2, 0, 0, true)).toBe(true);
});

it("pans with the secondary button only on the empty canvas", () => {
  expect(backgroundPan(2, true, false, "select")).toBe(true);
  expect(backgroundPan(2, false, false, "select")).toBe(false);
  expect(backgroundPan(0, true, false, "select")).toBe(false);
  expect(backgroundPan(0, true, true, "select")).toBe(true);
});
