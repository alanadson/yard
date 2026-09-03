/**
 * The addresses a portal has been to, offered back while typing. What has
 * to hold: a revisit moves an address up instead of duplicating it, the list
 * never grows without bound, and the suggestions rank what you typed at the
 * start of a host above a match buried in a path.
 */
import { describe, expect, it } from "vitest";

import { recordVisit, suggestUrls, type Visit } from "./urlHistory";

const at = (url: string, t: number, n = 1): Visit => ({ url, lastAt: t, count: n });

describe("recordVisit", () => {
  it("adds a new address at the front", () => {
    const out = recordVisit([at("https://a.dev", 1)], "https://b.dev", 2);
    expect(out.map((v) => v.url)).toEqual(["https://b.dev", "https://a.dev"]);
  });

  it("a revisit moves the address up and counts it, never duplicating", () => {
    const out = recordVisit([at("https://a.dev", 1), at("https://b.dev", 2)], "https://a.dev", 3);
    expect(out).toEqual([at("https://a.dev", 3, 2), at("https://b.dev", 2)]);
  });

  it("ignores blank and internal addresses", () => {
    expect(recordVisit([], "   ", 1)).toEqual([]);
    expect(recordVisit([], "about:blank", 1)).toEqual([]);
  });

  it("keeps the newest few hundred and drops the tail", () => {
    let list: Visit[] = [];
    for (let i = 0; i < 400; i++) list = recordVisit(list, `https://h${i}.dev`, i);
    expect(list.length).toBe(300);
    expect(list[0].url).toBe("https://h399.dev");
  });
});

describe("suggestUrls", () => {
  const list = [
    at("https://github.com/x/yard/pulls", 5, 2),
    at("http://localhost:5173/", 9, 20),
    at("https://docs.rs/tauri", 3),
    at("https://gitlab.com/a", 2),
  ];

  it("with nothing typed, the most recent come first", () => {
    expect(suggestUrls(list, "", 2).map((v) => v.url)).toEqual([
      "http://localhost:5173/",
      "https://github.com/x/yard/pulls",
    ]);
  });

  it("a host that starts with the text beats a path that merely contains it", () => {
    const out = suggestUrls(list, "git", 5).map((v) => v.url);
    expect(out[0]).toMatch(/^https:\/\/git/);
    expect(out).toContain("https://gitlab.com/a");
    expect(out).not.toContain("https://docs.rs/tauri");
  });

  it("matches anywhere in the address, case-insensitively, and caps the list", () => {
    expect(suggestUrls(list, "TAURI", 5).map((v) => v.url)).toEqual(["https://docs.rs/tauri"]);
    expect(suggestUrls(list, "", 1)).toHaveLength(1);
  });
});
