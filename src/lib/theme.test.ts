/**
 * The appearance preference has three words (dark, light, system) but the
 * window can only be in two states. This is the rule that turns one into the
 * other — and the contract that "dark" means *no attribute at all*, so a user
 * who never opens the setting keeps the exact CSS the app shipped with.
 */
import { describe, expect, it } from "vitest";

import { applyTheme, isThemePref, resolveTheme, restoreTheme } from "./theme";

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

  /**
   * The preference lives in SQLite, which is an `await` away: for the whole
   * boot the window has no idea it is meant to be light, and a light user
   * watched the shell open dark and flip. The mirror is what `restoreTheme`
   * reads at the top of `main.tsx` — so it has to be written on *both*
   * appearances, dark included, or the flip comes back the other way round.
   */
  it("mirrors the appearance where the next boot can read it before the first paint", () => {
    const f = fakeRoot();
    const remembered = new Map<string, string>();
    const store = { setItem: (k: string, v: string) => void remembered.set(k, v) };

    applyTheme(f.root, "light", store);
    expect(remembered.get("yard.theme")).toBe("light");

    applyTheme(f.root, "dark", store);
    expect(remembered.get("yard.theme")).toBe("dark");
  });

  it("still paints when there is no storage at all — a webview may refuse it", () => {
    const f = fakeRoot();
    const store = {
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    expect(() => applyTheme(f.root, "light", store)).not.toThrow();
    expect(f.attrs.get("data-theme")).toBe("light");
  });
});

/**
 * The other half of the mirror. `index.html` can only key on the OS
 * preference; whoever chose an appearance that disagrees with it — light on a
 * dark machine — used to watch the whole shell open dark and flip once the
 * preference came back from SQLite. This puts the attribute back before the
 * first render, from what `applyTheme` left behind.
 */
describe("restoreTheme", () => {
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
  const store = (value: string | null) => ({ getItem: () => value });

  it("puts back the appearance the last session resolved", () => {
    const f = fakeRoot();
    restoreTheme(f.root, store("light"));
    expect(f.attrs.get("data-theme")).toBe("light");
    expect(f.style.get("color-scheme")).toBe("light");
  });

  it("leaves the shipped dark alone — no attribute is what dark means", () => {
    const f = fakeRoot();
    f.root.setAttribute("data-theme", "light");
    restoreTheme(f.root, store("dark"));
    expect(f.attrs.has("data-theme")).toBe(false);
  });

  it("does nothing at all on a first run, or on a word it does not know", () => {
    for (const remembered of [null, "sepia", ""]) {
      const f = fakeRoot();
      restoreTheme(f.root, store(remembered));
      expect(f.attrs.has("data-theme"), `remembered ${remembered}`).toBe(false);
      expect(f.style.has("color-scheme")).toBe(false);
    }
  });

  it("survives storage that throws — the window has to open either way", () => {
    const f = fakeRoot();
    expect(() =>
      restoreTheme(f.root, {
        getItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).not.toThrow();
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
