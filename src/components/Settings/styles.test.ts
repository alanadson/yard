/**
 * The Settings window borrows the dialogs' sheet (`modals/modal.css`) instead
 * of keeping a second copy of `.modal-backdrop`, `.switch` and `.hint`. That
 * sheet also styles a bare `label`, and it stacks it — caption on top, field
 * below. Right in a form; wrong in a settings row, whose whole grammar is
 * "label on the left, control on the right". `NumberRow` really is a `<label>`
 * (the field is tied to its caption with no `htmlFor` at all), so the row
 * primitives have to say `flex-direction: row` out loud, not merely rely on
 * the default.
 *
 * The regression that motivated this file: a sweep that deleted the retired
 * store shelf's CSS matched a **grouped** selector —
 * `.set-row, .set-ext, .set-key-row { … }` — and took the two survivors with
 * it. Every row in the window lost `display: flex`, its padding and its
 * hairline in one go: captions clipped against the card's edge, controls
 * dropped onto the line below. The suite stayed green and the screen was
 * broken, which is exactly the hole this file fills.
 *
 * `?raw` instead of `fs`: the same loader `styles.test.ts` and
 * `theme-light.test.ts` use.
 */
import { describe, expect, it } from "vitest";

import modalCss from "../modals/modal.css?raw";
import settingsCss from "./settings.css?raw";

/** Every declaration a selector picks up, grouped selectors included. */
function declarationsFor(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const targets = rule[1].split(",").map((s) => s.trim());
    if (!targets.includes(selector)) continue;
    for (const decl of rule[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(decl[1], decl[2].trim());
    }
  }
  return out;
}

describe("the sheet the Settings window inherits", () => {
  it("stacks a bare label — the reason the rows must name their direction", () => {
    const label = declarationsFor(modalCss, "label");
    expect(label.get("display")).toBe("flex");
    expect(label.get("flex-direction")).toBe("column");
  });
});

describe("a row of a Settings card", () => {
  // `.set-row` is every ordinary row and `.set-row--num` is the numeric one,
  // which carries both classes; `.set-key-row` is the shortcuts table's.
  const ROWS = [".set-row", ".set-key-row"];

  it.each(ROWS)("%s lays label and control side by side", (selector) => {
    const row = declarationsFor(settingsCss, selector);
    expect(row.get("display"), `${selector} display`).toBe("flex");
    // Explicit, not inherited: `.set-row--num` is a <label>, which the
    // dialogs' sheet would stack.
    expect(row.get("flex-direction"), `${selector} flex-direction`).toBe("row");
    expect(row.get("align-items"), `${selector} align-items`).toBe("center");
  });

  it.each(ROWS)("%s keeps its own padding — a row flush with the card edge reads as clipped", (selector) => {
    expect(declarationsFor(settingsCss, selector).get("padding"), selector).toBeDefined();
  });

  it.each(ROWS)("%s draws the hairline that separates it from the row above", (selector) => {
    expect(declarationsFor(settingsCss, selector).get("border-top"), selector).toBeDefined();
  });

  it("the first row of a card drops that hairline — the card's own border is the stroke", () => {
    for (const selector of ROWS) {
      const first = declarationsFor(settingsCss, `${selector}:first-child`);
      expect(first.get("border-top"), selector).toBe("none");
    }
  });
});
