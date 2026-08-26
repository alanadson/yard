/**
 * Appearance — dark, light, or whatever the OS prefers.
 *
 * The app shipped dark-only, and the dark look is still the product's
 * identity: it is what `styles.css` paints with no help. The light
 * appearance is a second set of values for the same tokens
 * (`theme-light.css`), switched on by one attribute on `<html>`. Dark is
 * therefore the *absence* of the attribute — a user who never opens the
 * setting keeps the exact CSS they had.
 *
 * The rule (three words → two states) lives here, pure; `stores/themeStore`
 * owns the OS listener and the terminal well reads the resolved value from
 * there.
 */

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_PREFS: readonly ThemePref[] = ["dark", "light", "system"];

/** A picker's value is outside input; only the three words get through. */
export function isThemePref(value: unknown): value is ThemePref {
  return THEME_PREFS.includes(value as ThemePref);
}

/** The two states the window can be in, from the three words of the setting. */
export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

/** The slice of `document.documentElement` the switch needs. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

/**
 * Stamps (or clears) the attribute the light sheet keys on, and tells the
 * browser which way its own widgets — scrollbars, `<select>` pop-ups — go.
 * `color-scheme` is set inline because the sheet's own declaration only
 * reaches elements the sheet paints; the inline one is what the webview
 * reads for its chrome.
 */
export function applyTheme(root: ThemeRoot, resolved: ResolvedTheme): void {
  if (resolved === "light") {
    root.setAttribute("data-theme", "light");
    root.style.setProperty("color-scheme", "light");
    return;
  }
  root.removeAttribute("data-theme");
  root.style.removeProperty("color-scheme");
}

/** The next appearance for a one-key toggle: the opposite of what is on screen. */
export function toggledTheme(resolved: ResolvedTheme): ThemePref {
  return resolved === "dark" ? "light" : "dark";
}
