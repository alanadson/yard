/**
 * With the "Fontes de código embutidas" extension on, the boot used to pull
 * the CSS of all ten bundled families, while a profile uses one at most (the
 * terminal's, the editor's, the interface's). This is the decision of which
 * families the preferences actually name, so the boot loads only those and a
 * preference that switches to another family loads that one.
 */
import { describe, expect, it } from "vitest";

import { bundledFamiliesFor } from "./bundledFonts";

const DEFAULTS = {
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  codeFontFamily: "",
  uiFontFamily: "",
};

describe("bundledFamiliesFor", () => {
  it("names nothing when every preference is a default or an installed font", () => {
    expect(bundledFamiliesFor(DEFAULTS)).toEqual([]);
    expect(bundledFamiliesFor({ ...DEFAULTS, codeFontFamily: "Consolas" })).toEqual([]);
  });

  it("names the bundled family at the head of the terminal's stack", () => {
    expect(
      bundledFamiliesFor({ ...DEFAULTS, fontFamily: '"JetBrains Mono", Consolas, monospace' }),
    ).toEqual(["JetBrains Mono"]);
  });

  it("names the editor's and the interface's bundled families too", () => {
    expect(
      bundledFamiliesFor({ ...DEFAULTS, codeFontFamily: "Fira Code", uiFontFamily: "Geist Mono" }),
    ).toEqual(["Fira Code", "Geist Mono"]);
  });

  it("names a family chosen in two places once", () => {
    expect(
      bundledFamiliesFor({
        fontFamily: '"Iosevka", Consolas, monospace',
        codeFontFamily: "Iosevka",
        uiFontFamily: "",
      }),
    ).toEqual(["Iosevka"]);
  });
});
