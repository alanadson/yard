/**
 * The appearance preference has three words (dark, light, system) but the
 * window can only be in two states. This is the rule that turns one into the
 * other — and the contract that "dark" means *no attribute at all*, so a user
 * who never opens the setting keeps the exact CSS the app shipped with.
 */
import { describe, expect, it } from "vitest";

import { applyTheme, isThemePref, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("an explicit choice ignores what the system prefers", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("system follows the OS, both ways", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("applyTheme", () => {
  function fakeRoot() {
    const attrs = new Map<string, string>();
    const style = new Map<string, string>();
    return {
      attrs,
      style,
      root: {
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
        removeAttribute: (k: string) => void attrs.delete(k),
        style: {
          setProperty: (k: string, v: string) => void style.set(k, v),
          removeProperty: (k: string) => void style.delete(k),
        },
      },
    };
  }

  it("light stamps data-theme and tells the browser its widgets are light", () => {
    const f = fakeRoot();
    applyTheme(f.root, "light");
    expect(f.attrs.get("data-theme")).toBe("light");
    expect(f.style.get("color-scheme")).toBe("light");
  });

  it("dark leaves no trace — the shipped CSS is the dark theme", () => {
    const f = fakeRoot();
    applyTheme(f.root, "light");
    applyTheme(f.root, "dark");
    expect(f.attrs.has("data-theme")).toBe(false);
    expect(f.style.has("color-scheme")).toBe(false);
  });
});

describe("isThemePref", () => {
  it("accepts the three words of the setting and nothing else — a picker value is outside input", () => {
    expect(isThemePref("light")).toBe(true);
    expect(isThemePref("system")).toBe(true);
    expect(isThemePref("sepia")).toBe(false);
    expect(isThemePref(undefined)).toBe(false);
  });
});
