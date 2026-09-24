// A failed or in-flight comparison cannot authorize a merge using an old preview.
import { expect, it } from "vitest";
import { landActions } from "./landState";

it("offers retry after the first comparison fails and blocks landing stale previews", () => {
  expect(
    landActions({
      hasPreview: false,
      blocked: true,
      error: "offline",
      comparing: false,
      busy: false,
    }),
  ).toEqual({ canRetry: true, canLand: false });
  expect(
    landActions({
      hasPreview: true,
      blocked: false,
      error: "offline",
      comparing: false,
      busy: false,
    }).canLand,
  ).toBe(false);
  expect(
    landActions({
      hasPreview: true,
      blocked: false,
      error: null,
      comparing: true,
      busy: false,
    }).canLand,
  ).toBe(false);
  expect(
    landActions({
      hasPreview: true,
      blocked: false,
      error: null,
      comparing: false,
      busy: false,
    }).canLand,
  ).toBe(true);
});
