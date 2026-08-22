import { describe, expect, it } from "vitest";

import { PortalBoundsQueue } from "./portalBoundsQueue";

const place = { x: 1, y: 2, w: 300, h: 200, visible: true, holes: [] };

describe("PortalBoundsQueue", () => {
  it("keeps only the last placement in a frame", () => {
    const queue = new PortalBoundsQueue();
    queue.enqueue("p", place);
    queue.enqueue("p", { ...place, x: 7 });
    expect(queue.drain()).toEqual([{ id: "p", place: { ...place, x: 7 } }]);
  });

  it("does not resend an unchanged placement", () => {
    const queue = new PortalBoundsQueue();
    queue.enqueue("p", place);
    expect(queue.drain()).toHaveLength(1);
    queue.enqueue("p", { ...place });
    expect(queue.drain()).toEqual([]);
  });
});
