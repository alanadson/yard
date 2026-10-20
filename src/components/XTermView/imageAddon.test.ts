/**
 * The image addon (sixel / iTerm inline pictures) keeps decoded pixels per
 * terminal. Its defaults (128 MB of storage, 16 megapixels per picture) are
 * sized for one terminal on a desktop, not a board of ten agents: two numbers
 * keep it bounded, and they have to agree with each other.
 */
import { describe, expect, it } from "vitest";

import { IMAGE_ADDON_OPTIONS } from "./imageAddon";

const MB = 1024 * 1024;

describe("IMAGE_ADDON_OPTIONS", () => {
  it("caps the image memory of each terminal far below the addon's 128 MB default", () => {
    expect(IMAGE_ADDON_OPTIONS.storageLimit).toBeLessThanOrEqual(16);
  });

  it("lets the largest picture accepted fit in that budget, so it is not evicted by its own arrival", () => {
    // The addon stores 4 bytes per pixel.
    expect(IMAGE_ADDON_OPTIONS.pixelLimit * 4).toBeLessThanOrEqual(IMAGE_ADDON_OPTIONS.storageLimit * MB);
    // Still room for a 2048 x 2048 screenshot.
    expect(IMAGE_ADDON_OPTIONS.pixelLimit).toBeGreaterThanOrEqual(2048 * 2048);
  });
});
