/**
 * Starred addresses: one star toggles, the same address is never listed
 * twice, and a bookmark keeps the name the page had when it was starred.
 */
import { describe, expect, it } from "vitest";

import { isBookmarked, normalizeBookmarks, toggleBookmark } from "./portalBookmarks";

describe("toggleBookmark", () => {
  it("stars an address with its name, and unstars it on the second toggle", () => {
    const once = toggleBookmark([], { url: "https://a.dev/x", name: "A" });
    expect(once).toEqual([{ url: "https://a.dev/x", name: "A" }]);
    expect(isBookmarked(once, "https://a.dev/x")).toBe(true);
    const twice = toggleBookmark(once, { url: "https://a.dev/x", name: "A" });
    expect(twice).toEqual([]);
    expect(isBookmarked(twice, "https://a.dev/x")).toBe(false);
  });

  it("treats a trailing slash as the same address", () => {
    const list = toggleBookmark([], { url: "https://a.dev/", name: "A" });
    expect(isBookmarked(list, "https://a.dev")).toBe(true);
  });

  it("a blank name falls back to the host", () => {
    expect(toggleBookmark([], { url: "https://docs.rs/tauri", name: "  " })[0].name).toBe("docs.rs");
  });
});

describe("normalizeBookmarks", () => {
  it("keeps only rows with a url, and drops junk and duplicates", () => {
    expect(
      normalizeBookmarks([
        { url: "https://a.dev", name: "A" },
        { url: "https://a.dev/", name: "A again" },
        { name: "no url" },
        "junk",
        { url: "https://b.dev", name: 7 },
      ]),
    ).toEqual([
      { url: "https://a.dev", name: "A" },
      { url: "https://b.dev", name: "b.dev" },
    ]);
    expect(normalizeBookmarks("junk")).toEqual([]);
  });
});
