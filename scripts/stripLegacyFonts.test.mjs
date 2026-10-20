/**
 * Why these rules matter: the only browser this bundle ever runs in is
 * WebView2, which always picks the woff2 entry of an `@font-face` `src` list.
 * Fontsource and KaTeX still list `.woff` (and KaTeX `.ttf`) after it, and
 * Vite emits every file a stylesheet names: 108 `.woff` and 20 `.ttf` files,
 * about a third of the installer, that no user can ever download into a font.
 *
 * The other half of the rule is just as important: a face that has **no**
 * woff2 must keep what it has, or the font silently stops loading. And the
 * rewrite is scoped to the font packages, never to the app's own CSS.
 */
import { describe, expect, it } from "vitest";

import { legacyFontsPlugin, stripLegacyFontSources } from "./stripLegacyFonts.mjs";

const FONTSOURCE_FACE = `/* jetbrains-mono-greek-400-normal */
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url(./files/jetbrains-mono-greek-400-normal.woff2) format('woff2'), url(./files/jetbrains-mono-greek-400-normal.woff) format('woff');
  unicode-range: U+0370-0377,U+037A-037F;
}
`;

const KATEX_MINIFIED =
  '@font-face{font-display:block;font-family:KaTeX_AMS;font-style:normal;font-weight:400;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),url(fonts/KaTeX_AMS-Regular.woff) format("woff"),url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")}' +
  '@font-face{font-display:block;font-family:KaTeX_Main;font-style:normal;font-weight:700;src:url(fonts/KaTeX_Main-Bold.woff2) format("woff2"),url(fonts/KaTeX_Main-Bold.woff) format("woff"),url(fonts/KaTeX_Main-Bold.ttf) format("truetype")}' +
  ".katex{font:normal 1.21em KaTeX_Main,Times New Roman,serif;line-height:1.2}";

describe("stripLegacyFontSources", () => {
  it("keeps only the woff2 source of a Fontsource face and leaves the rest of the rule alone", () => {
    expect(stripLegacyFontSources(FONTSOURCE_FACE)).toBe(
      FONTSOURCE_FACE.replace(", url(./files/jetbrains-mono-greek-400-normal.woff) format('woff')", ""),
    );
  });

  it("drops woff and truetype from KaTeX's minified faces without eating the closing brace", () => {
    expect(stripLegacyFontSources(KATEX_MINIFIED)).toBe(
      '@font-face{font-display:block;font-family:KaTeX_AMS;font-style:normal;font-weight:400;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2")}' +
        '@font-face{font-display:block;font-family:KaTeX_Main;font-style:normal;font-weight:700;src:url(fonts/KaTeX_Main-Bold.woff2) format("woff2")}' +
        ".katex{font:normal 1.21em KaTeX_Main,Times New Roman,serif;line-height:1.2}",
    );
  });

  it("counts woff2-variations as woff2, so a variable font keeps its file", () => {
    const css = "@font-face{src: url(./inter.woff2) format('woff2-variations'), url(./inter.woff) format('woff');}";
    expect(stripLegacyFontSources(css)).toBe("@font-face{src: url(./inter.woff2) format('woff2-variations');}");
  });

  it("recognises a woff2 source by its extension when it carries no format()", () => {
    const css = "@font-face{src: url(a.woff2), url(a.woff);}";
    expect(stripLegacyFontSources(css)).toBe("@font-face{src: url(a.woff2);}");
  });

  it("leaves a face with no woff2 source untouched, so that font still loads", () => {
    const css = "@font-face{font-family:Old;src: url(old.woff) format('woff'), url(old.ttf) format('truetype');}";
    expect(stripLegacyFontSources(css)).toBe(css);
  });

  it("keeps local() sources, which cost nothing in the bundle", () => {
    const css = "@font-face{src: local('Fira Code'), url(f.woff2) format('woff2'), url(f.woff) format('woff');}";
    expect(stripLegacyFontSources(css)).toBe("@font-face{src: local('Fira Code'), url(f.woff2) format('woff2');}");
  });

  it("does not split a source on the comma or semicolon inside a data URI", () => {
    const css = '@font-face{src: url("data:font/woff2;base64,d09G,Mg") format("woff2"), url(f.woff) format("woff");}';
    expect(stripLegacyFontSources(css)).toBe('@font-face{src: url("data:font/woff2;base64,d09G,Mg") format("woff2");}');
  });

  it("does not mistake a property that merely ends in src for a font source list", () => {
    const css = ".x{--img-src: url(a.woff2), url(a.woff);}";
    expect(stripLegacyFontSources(css)).toBe(css);
  });
});

describe("legacyFontsPlugin", () => {
  const plugin = legacyFontsPlugin();
  const LEGACY = "@font-face{src:url(a.woff2) format('woff2'),url(a.woff) format('woff')}";
  const STRIPPED = "@font-face{src:url(a.woff2) format('woff2')}";

  it("runs before Vite's own CSS plugin, which is what turns every url() into an emitted asset", () => {
    expect(plugin.enforce).toBe("pre");
  });

  it("rewrites the stylesheets of Fontsource and KaTeX, including mermaid's nested copy and query ids", () => {
    for (const id of [
      "C:\\Workspace\\Code\\yard\\node_modules\\@fontsource\\fira-code\\400.css",
      "/repo/node_modules/@fontsource-variable/inter/index.css",
      "/repo/node_modules/katex/dist/katex.min.css?inline",
      "/repo/node_modules/mermaid/node_modules/katex/dist/katex.min.css",
    ]) {
      expect(plugin.transform(LEGACY, id), id).toBe(STRIPPED);
    }
  });

  it("leaves every other module alone, the app's own CSS included", () => {
    for (const id of [
      "/repo/src/styles.css",
      "/repo/node_modules/@xterm/xterm/css/xterm.css",
      "/repo/node_modules/katex/dist/katex.mjs",
    ]) {
      expect(plugin.transform(LEGACY, id), id).toBeNull();
    }
  });

  it("returns null when a font stylesheet has nothing to strip, so Vite keeps the original", () => {
    expect(plugin.transform(STRIPPED, "/repo/node_modules/@fontsource/iosevka/400.css")).toBeNull();
  });
});
