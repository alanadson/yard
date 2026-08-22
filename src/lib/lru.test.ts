import { describe, expect, it } from "vitest";

import { LruCache } from "./lru";

describe("LruCache", () => {
  it("evicts the least recently used value", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1).set("b", 2);
    expect(cache.get("a")).toBe(1);

    cache.set("c", 3);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("rejects limits that could silently grow or evict everything", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });
});
