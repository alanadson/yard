/**
 * The `:root` of `styles.css` says, in a comment, that white over `--accent`
 * measures 3.65:1 and falls below the 4.5:1 the product promises — which is
 * why `--accent-fill` exists. A comment holds nothing: two screens slipped
 * onto the wrong token after that (the notebook's active tag and the file
 * tree's "try again").
 *
 * The math lives here. It is closed-form and deterministic — the WCAG 2.1
 * formula, nothing more — and the contract test that applies it to the real
 * CSS is in `src/styles.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { passesAA, contrastRatio, blendOver, lightness } from "./contrast";

describe("contrast ratio", () => {
  it("black and white is the far end of the scale", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 2);
  });

  it("a color against itself contrasts with nothing", () => {
    expect(contrastRatio("#0a84ff", "#0a84ff")).toBeCloseTo(1, 5);
  });

  it("order does not change the result — contrast is symmetric", () => {
    const a = contrastRatio("#e2e2e6", "#1a1a1e");
    const b = contrastRatio("#1a1a1e", "#e2e2e6");
    expect(a).toBeCloseTo(b, 6);
  });

  it("measures the case that motivated the module: white over the system blue", () => {
    // The number the `:root` comment promises.
    expect(contrastRatio("#ffffff", "#0a84ff")).toBeCloseTo(3.65, 2);
  });

  it("and the blue one step deeper, which is what carries white text", () => {
    expect(contrastRatio("#ffffff", "#0f6fd6")).toBeCloseTo(4.92, 2);
  });

  it("accepts the short form and the `rgb()` the CSS uses", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 2);
    expect(contrastRatio("rgb(255 255 255)", "#000000")).toBeCloseTo(21, 2);
  });
});

describe("sobrepor", () => {
  it("full opacity returns the top color itself", () => {
    expect(blendOver("rgb(255 105 97 / 100%)", "#1a1a1e")).toBe("#ff6961");
  });

  it("zero opacity returns the background", () => {
    expect(blendOver("rgb(255 105 97 / 0%)", "#1a1a1e")).toBe("#1a1a1e");
  });

  it("composites the translucent error background over the panel", () => {
    // `--red-bg` over `--bg-panel`: this is the real background of "try again".
    expect(blendOver("rgb(255 105 97 / 13%)", "#1a1a1e")).toBe("#382427");
  });
});

describe("passaAA", () => {
  it("4.5:1 is the floor for normal text — and it passes", () => {
    expect(passesAA(4.5)).toBe(true);
    expect(passesAA(4.49)).toBe(false);
  });
});

/**
 * Contrast answers "can this be read". It cannot answer "can these two
 * surfaces be told apart", which is the other half of a dark appearance: the
 * whole chrome of this app lives in the bottom tenth of the scale, where the
 * ratio between two neighbouring surfaces is a number like 1.4:1 for a step
 * the eye reads clearly and 1.4:1 again for one it does not.
 *
 * CIE L* is the measure that behaves the same at both ends — the ladder in
 * `src/styles.test.ts` is written in it.
 */
describe("perceptual lightness", () => {
  it("spans the scale from black to white", () => {
    expect(lightness("#000000")).toBeCloseTo(0, 4);
    expect(lightness("#ffffff")).toBeCloseTo(100, 4);
  });

  it("puts middle grey in the middle, which is the whole point of using it", () => {
    // #777 is ~18% luminance — the ratio scale calls it dark, the eye does not.
    expect(lightness("#777777")).toBeGreaterThan(48);
    expect(lightness("#777777")).toBeLessThan(52);
  });

  it("stays linear down in the dark, where a ratio stops saying anything", () => {
    // The app's ground and the surface above it: two steps the eye reads as
    // equal, and the ratio calls 1.24:1 and 1.19:1.
    const low = lightness("#202025") - lightness("#1a1a1e");
    const high = lightness("#c8c8cc") - lightness("#c0c0c4");
    expect(Math.abs(low - high)).toBeLessThan(1.5);
  });

  it("reads the same forms the CSS writes", () => {
    expect(lightness("#fff")).toBeCloseTo(lightness("rgb(255 255 255)"), 4);
  });
});
