/**
 * The resolved appearance is one value with two owners — the preference in
 * the UI store and the OS's `prefers-color-scheme` — and every surface that
 * paints its own pixels (the terminal well, the editor) reads it from here.
 * `startTheme` is the only place that touches `<html>`; it has to react to
 * both owners and stop cleanly, or a reload leaves two listeners fighting.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resolvedTheme, startTheme, useThemeStore } from "./themeStore";
import { DEFAULT_PREFS, useUI } from "./uiStore";

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    root: {
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
      style: {
        setProperty: () => {},
        removeProperty: () => {},
      },
    },
  };
}

/** The slice of `MediaQueryList` the store needs, driven by hand. */
function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    query: {
      get matches() {
        return matches;
      },
      addEventListener: (_: "change", cb: () => void) => void listeners.add(cb),
      removeEventListener: (_: "change", cb: () => void) => void listeners.delete(cb),
    },
    flip(next: boolean) {
      matches = next;
      for (const cb of listeners) cb();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

beforeEach(() => {
  useUI.setState({ prefs: { ...DEFAULT_PREFS } });
  useThemeStore.setState({ systemDark: true });
});

describe("resolvedTheme", () => {
  it("is dark out of the box — the shipped look, whatever the OS says", () => {
    useThemeStore.setState({ systemDark: false });
    expect(resolvedTheme()).toBe("dark");
  });

  it("system follows the OS once the user asks for it", () => {
    useUI.getState().setPrefLocal("theme", "system");
    useThemeStore.setState({ systemDark: false });
    expect(resolvedTheme()).toBe("light");
    useThemeStore.setState({ systemDark: true });
    expect(resolvedTheme()).toBe("dark");
  });
});

describe("startTheme", () => {
  it("applies on start and again when the preference changes", () => {
    const f = fakeRoot();
    const media = fakeMedia(true);
    const stop = startTheme(f.root, media.query);
    expect(f.attrs.has("data-theme")).toBe(false);
    useUI.getState().setPrefLocal("theme", "light");
    expect(f.attrs.get("data-theme")).toBe("light");
    stop();
  });

  it("with the preference on system, an OS change repaints; an explicit choice ignores it", () => {
    const f = fakeRoot();
    const media = fakeMedia(true);
    const stop = startTheme(f.root, media.query);
    useUI.getState().setPrefLocal("theme", "system");
    expect(f.attrs.has("data-theme")).toBe(false);
    media.flip(false);
    expect(f.attrs.get("data-theme")).toBe("light");
    useUI.getState().setPrefLocal("theme", "dark");
    media.flip(true);
    media.flip(false);
    expect(f.attrs.has("data-theme")).toBe(false);
    stop();
  });

  it("stopping removes the OS listener and stops following the preference", () => {
    const f = fakeRoot();
    const media = fakeMedia(false);
    const stop = startTheme(f.root, media.query);
    expect(media.listeners).toBe(1);
    stop();
    expect(media.listeners).toBe(0);
    useUI.getState().setPrefLocal("theme", "light");
    expect(f.attrs.has("data-theme")).toBe(false);
  });

  it("runs without matchMedia at all (tests, an old webview): dark, no crash", () => {
    const f = fakeRoot();
    const stop = startTheme(f.root, null);
    useUI.getState().setPrefLocal("theme", "system");
    expect(f.attrs.has("data-theme")).toBe(false);
    stop();
  });
});
