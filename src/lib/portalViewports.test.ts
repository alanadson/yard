/**
 * A portal sized like a phone is a phone-sized page: the card's own size is
 * the viewport the site sees (`yard portal resize` keeps the same rule), so
 * a preset is a card size plus the chrome around the page.
 */
import { describe, expect, it } from "vitest";

import { cardSizeForViewport, PORTAL_CHROME_H, PORTAL_VIEWPORTS } from "./portals";

describe("portal viewport presets", () => {
  it("offers a phone, a tablet and a desktop, each a real device size", () => {
    const ids = PORTAL_VIEWPORTS.map((p) => p.id);
    expect(ids).toEqual(["phone", "tablet", "desktop"]);
    for (const p of PORTAL_VIEWPORTS) {
      expect(p.w).toBeGreaterThan(300);
      expect(p.h).toBeGreaterThan(300);
    }
  });

  it("the card is the viewport plus the chrome, never smaller than the card's floor", () => {
    const phone = PORTAL_VIEWPORTS[0];
    expect(cardSizeForViewport(phone)).toEqual({
      w: Math.max(320, phone.w + 2),
      h: phone.h + PORTAL_CHROME_H,
    });
  });
});
