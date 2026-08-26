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

/** The two halves of `localStorage` this module needs — injectable, for the test. */
export interface ThemeMemory {
  setItem(key: string, value: string): void;
}

export interface ThemeRecall {
  getItem(key: string): string | null;
}

/** Where the resolved appearance waits for the next boot. */
export const THEME_MEMORY_KEY = "yard.theme";

/**
 * Stamps (or clears) the attribute the light sheet keys on, and tells the
 * browser which way its own widgets — scrollbars, `<select>` pop-ups — go.
 * `color-scheme` is set inline because the sheet's own declaration only
 * reaches elements the sheet paints; the inline one is what the webview
 * reads for its chrome.
 *
 * It also leaves the resolved appearance where the next boot can find it
 * synchronously. The preference itself lives in SQLite, an `await` away: with
 * no mirror the shell paints its default for the whole boot and flips once
 * the store answers, which a light user sees as a black flash every launch.
 * Storage can be refused (a locked-down webview, a private profile) and that
 * is not worth a broken window, so the write never escapes.
 */
export function applyTheme(root: ThemeRoot, resolved: ResolvedTheme, memory?: ThemeMemory | null): void {
  try {
    // Reading the global is inside the `try` on purpose: a webview with
    // storage switched off does not hand back `undefined`, it throws on the
    // property itself.
    const store = memory === undefined ? globalThis.localStorage : memory;
    store?.setItem(THEME_MEMORY_KEY, resolved);
  } catch {
    // A window that opens in the wrong appearance for one frame beats no window.
  }
  if (resolved === "light") {
    root.setAttribute("data-theme", "light");
    root.style.setProperty("color-scheme", "light");
    return;
  }
  root.removeAttribute("data-theme");
  root.style.removeProperty("color-scheme");
}

/**
 * Puts the last resolved appearance back on `<html>`, before the first render.
 *
 * `index.html` paints a ground of its own, but all it can key on is
 * `prefers-color-scheme`: whoever picked an appearance that disagrees with the
 * machine used to watch the whole shell open in the wrong one and flip when
 * the preference came back from SQLite. Called at the top of `main.tsx` — not
 * from an inline `<script>` in the page, which the production CSP
 * (`script-src 'self'`) would refuse.
 *
 * Anything other than the two known words is left alone: a first run has
 * nothing stored, and the OS preference is the better guess than a coin flip.
 */
export function restoreTheme(root: ThemeRoot, memory?: ThemeRecall | null): void {
  let remembered: string | null = null;
  try {
    const store = memory === undefined ? globalThis.localStorage : memory;
    remembered = store ? store.getItem(THEME_MEMORY_KEY) : null;
  } catch {
    return; // Storage refused; the sheet's own default is already on screen.
  }
  if (remembered === "light" || remembered === "dark") applyTheme(root, remembered, null);
}

/** The next appearance for a one-key toggle: the opposite of what is on screen. */
export function toggledTheme(resolved: ResolvedTheme): ThemePref {
  return resolved === "dark" ? "light" : "dark";
}
