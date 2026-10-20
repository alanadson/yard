/**
 * A Mermaid diagram or a KaTeX formula was rendered again every time its
 * block mounted: scrolling a long note back and forth, switching tabs or
 * toggling the preview re-ran Mermaid's layout for diagrams that had not
 * changed. Rendered markup is kept per source and theme, up to 50 blocks.
 */
import { describe, expect, it } from "vitest";

import { createRenderCache, RENDER_CACHE_SIZE } from "./renderCache";

describe("createRenderCache", () => {
  it("hands back what a block rendered for the same source and theme", () => {
    const cache = createRenderCache();
    cache.set("mermaid", "dark", "graph TD; A-->B", "<svg>ab</svg>");
    expect(cache.get("mermaid", "dark", "graph TD; A-->B")).toBe("<svg>ab</svg>");
  });

  it("renders anew when the source, the theme or the kind of block differs", () => {
    const cache = createRenderCache();
    cache.set("mermaid", "dark", "graph TD; A-->B", "<svg>ab</svg>");
    expect(cache.get("mermaid", "light", "graph TD; A-->B")).toBeUndefined();
    expect(cache.get("mermaid", "dark", "graph TD; A-->C")).toBeUndefined();
    expect(cache.get("katex", "dark", "graph TD; A-->B")).toBeUndefined();
  });

  it("keeps at most the 50 blocks used most recently", () => {
    const cache = createRenderCache();
    for (let i = 0; i <= RENDER_CACHE_SIZE; i++) cache.set("katex", "", `x^${i}`, `<b>${i}</b>`);
    expect(RENDER_CACHE_SIZE).toBe(50);
    expect(cache.get("katex", "", "x^0")).toBeUndefined();
    expect(cache.get("katex", "", `x^${RENDER_CACHE_SIZE}`)).toBe(`<b>${RENDER_CACHE_SIZE}</b>`);
  });
});
