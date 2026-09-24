/**
 * `patchNode` rebuilds a card's `nodes` entry field by field so that an
 * explicit `undefined` really removes a key. The regression this locks down:
 * the rebuild forgot `dock` and `contentHidden`, so picking a colour or a
 * font size silently undocked the card and revealed content the user had
 * chosen to hide.
 */
import { describe, expect, it } from "vitest";

import type { CanvasNode } from "../../lib/canvas";
import { nextNode } from "./patchNodeRule";

const rect = { x: 10, y: 20, w: 300, h: 200 };

describe("nextNode", () => {
  it("keeps dock and contentHidden when only the colour changes", () => {
    const prev: CanvasNode = { ...rect, dock: "left", contentHidden: true };
    const next = nextNode(prev, { color: "#ff0000" }, rect);
    expect(next.dock).toBe("left");
    expect(next.contentHidden).toBe(true);
    expect(next.color).toBe("#ff0000");
  });

  it("an explicit undefined still removes the colour key", () => {
    const prev: CanvasNode = { ...rect, color: "#ff0000", dock: "right" };
    const next = nextNode(prev, { color: undefined }, rect);
    expect("color" in next).toBe(false);
    expect(next.dock).toBe("right");
  });

  it("takes the live rectangle, not the stored one", () => {
    const prev: CanvasNode = { x: 0, y: 0, w: 1, h: 1, fontSize: 14 };
    const next = nextNode(prev, { color: "#00ff00" }, rect);
    expect(next).toMatchObject({ ...rect, fontSize: 14, color: "#00ff00" });
  });

  it("never writes a dock or contentHidden key that was absent", () => {
    const next = nextNode({ ...rect }, { fontSize: 16 }, rect);
    expect("dock" in next).toBe(false);
    expect("contentHidden" in next).toBe(false);
  });
});
