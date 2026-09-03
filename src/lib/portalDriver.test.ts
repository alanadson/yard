/**
 * The scripts the `yard portal` verbs inject. Two things matter to whoever
 * watches the card: the agent's action leaves a visible mark on the element
 * it touched (a page that changes with no cursor is a page nobody trusts),
 * and the mark never stays behind.
 */
import { describe, expect, it } from "vitest";

import { clickJs, fillJs, hoverJs, typeJs } from "./portalDriver";

describe("the agent's actions leave a visible mark on the page", () => {
  it("click, fill, type and hover all draw the mark on the element they touch", () => {
    for (const js of [clickJs("#go"), fillJs("#q", "x"), typeJs("#q", "x"), hoverJs("#go")]) {
      expect(js).toContain("data-yard-mark");
      // Still the same contract for the caller: a missing element says so.
      expect(js).toContain('"missing"');
    }
  });

  it("the mark never survives: it removes itself", () => {
    expect(clickJs("#go")).toMatch(/remove\(\)/);
  });
});
