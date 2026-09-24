/**
 * The `portalNav` event arrives for every navigation of every portal in the
 * app. The handler of each board used to answer with a fresh canvas object
 * even when the portal was not on that board, and every fresh object is a
 * layout write plus a workspace save: navigating one portal rewrote every
 * open board. The rule: the same canvas comes back when nothing matched.
 */
import { describe, expect, it } from "vitest";

import { EMPTY_CANVAS, type CanvasData, type CanvasItem } from "../../lib/canvas";
import { navigatePortal } from "./portalNav";

const portal: CanvasItem = {
  id: "p1",
  type: "portal",
  color: "#000",
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  url: "https://a.example",
};

const canvas: CanvasData = { ...EMPTY_CANVAS, items: [portal] };

describe("navigatePortal", () => {
  it("returns the very same canvas when no portal has that id", () => {
    expect(navigatePortal(canvas, "other", "https://b.example")).toBe(canvas);
  });

  it("returns the very same canvas when the portal is already on that url", () => {
    expect(navigatePortal(canvas, "p1", "https://a.example")).toBe(canvas);
  });

  it("rewrites the url of the matching portal only", () => {
    const next = navigatePortal(canvas, "p1", "https://b.example");
    expect(next).not.toBe(canvas);
    expect(next.items[0]).toMatchObject({ id: "p1", url: "https://b.example" });
  });
});
