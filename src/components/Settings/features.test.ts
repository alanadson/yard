/**
 * Everything the Yard bundles and leaves switched off used to live on a store
 * shelf of its own (`Ctrl+Shift+X`), which is gone: a feature that ships with
 * the app is a setting, and it belongs on the page of the surface it changes —
 * the terminal's with the terminal, the editor's with the editor.
 *
 * The shelf listed the catalog, so nothing could be forgotten. Rows written by
 * hand in each section have the opposite failure mode, and it is silent: a new
 * id lands in `lib/extensions.ts`, the code that reads it ships, and no screen
 * in the app can turn it on. This test reads the sections' own source and asks
 * the question the shelf used to answer by construction.
 *
 * `?raw` instead of `fs`: the same loader `styles.test.ts` uses, and the suite
 * stays free of new dependencies.
 */
import { describe, expect, it } from "vitest";

import editorSrc from "./sections/Editor.tsx?raw";
import interfaceSrc from "./sections/Interface.tsx?raw";
import terminalSrc from "./sections/Terminal.tsx?raw";
import { SCHEME_IDS } from "../../lib/colorSchemes";
import { EXTENSIONS } from "../../lib/extensions";
import { ICON_THEMES } from "../../lib/iconTheme";

const SECTIONS: Record<string, string> = {
  Interface: interfaceSrc,
  Terminal: terminalSrc,
  Editor: editorSrc,
};

/** Where an id is switched, if it is switched anywhere. */
function pageOf(id: string): string | undefined {
  return Object.keys(SECTIONS).find((name) => SECTIONS[name].includes(`"${id}"`));
}

describe("every bundled feature has a control in Configurações", () => {
  const schemes = new Set<string>(SCHEME_IDS);
  const icons = new Set<string>(ICON_THEMES.map((t) => t.id));

  it("each one is switched on some page — the shelf that listed them all is gone", () => {
    const missing = EXTENSIONS.filter(
      (e) => !schemes.has(e.id) && !icons.has(e.id) && pageOf(e.id) === undefined,
    ).map((e) => e.id);
    expect(missing).toEqual([]);
  });

  it("the colour scheme is a picker on both surfaces, one slot each", () => {
    expect(terminalSrc).toContain("schemeOptions");
    expect(editorSrc).toContain("schemeOptions");
  });

  it("the icon theme is a picker in Editor de código — one slot for the two themes", () => {
    expect(editorSrc).toContain("iconThemeOptions");
    expect(icons.size).toBeGreaterThan(1);
  });

  /**
   * The page a feature sits on is the whole point of retiring the shelf: a
   * switch reached by looking at what it changes, not by browsing a catalog.
   */
  it("the terminal's features are on the terminal's page, the editor's on the editor's", () => {
    expect(pageOf("term-images")).toBe("Terminal");
    for (const id of ["minimap", "indent-guides", "css-colors", "format-on-save", "mermaid"]) {
      expect(pageOf(id), id).toBe("Editor");
    }
    expect(pageOf("code-fonts")).toBe("Interface");
  });
});
