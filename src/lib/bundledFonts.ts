/**
 * The code fonts the "Fontes de código embutidas" switch ships (Ajustes →
 * Interface → Fontes) — all OFL 1.1, all
 * packaged via Fontsource (the repo rule: every resource bundled, nothing
 * fetched at runtime — §DESIGN "empacotar todo recurso").
 *
 * The CSS files are imported dynamically, so the woff2 payload stays out of
 * every profile that never turns the switch on. Loading is idempotent and
 * the `@font-face` rules stay for the session once in — a font that vanished
 * mid-session would leave the terminal measuring a family that no longer
 * resolves.
 *
 * And they are imported per family: the boot loads only the families the
 * preferences name (`bundledFamiliesFor`), a preference that switches to
 * another family loads that one, and the whole set is one call away for a
 * picker that previews each family in its own face (`loadBundledFonts`).
 *
 * The pickers in Preferências list *installed* fonts (`ipc.listFonts`); these
 * families ride in through the same list when the extension is on, shaped
 * like `FontFamilyInfo` so the ligature checkbox logic just works.
 */
import type { FontFamilyInfo } from "./ipc";

export const BUNDLED_FONTS: readonly FontFamilyInfo[] = [
  { family: "JetBrains Mono", mono: true, ligatures: true },
  { family: "Fira Code", mono: true, ligatures: true },
  { family: "Victor Mono", mono: true, ligatures: true },
  { family: "IBM Plex Mono", mono: true, ligatures: false },
  { family: "Monaspace Neon", mono: true, ligatures: true },
  { family: "Iosevka", mono: true, ligatures: true },
  { family: "Source Code Pro", mono: true, ligatures: false },
  { family: "Commit Mono", mono: true, ligatures: true },
  { family: "Geist Mono", mono: true, ligatures: true },
  { family: "Intel One Mono", mono: true, ligatures: false },
];

/**
 * Each family's @font-face rules (400/700; Victor keeps its italic). One
 * loader per family, with literal specifiers, so the bundler still splits
 * every sheet into its own chunk.
 */
const FAMILY_CSS: ReadonlyMap<string, () => Promise<unknown>[]> = new Map(Object.entries({
  "JetBrains Mono": () => [
    import("@fontsource/jetbrains-mono/400.css"),
    import("@fontsource/jetbrains-mono/700.css"),
  ],
  "Fira Code": () => [
    import("@fontsource/fira-code/400.css"),
    import("@fontsource/fira-code/700.css"),
  ],
  "Victor Mono": () => [
    import("@fontsource/victor-mono/400.css"),
    import("@fontsource/victor-mono/400-italic.css"),
    import("@fontsource/victor-mono/700.css"),
  ],
  "IBM Plex Mono": () => [
    import("@fontsource/ibm-plex-mono/400.css"),
    import("@fontsource/ibm-plex-mono/700.css"),
  ],
  "Monaspace Neon": () => [
    import("@fontsource/monaspace-neon/400.css"),
    import("@fontsource/monaspace-neon/700.css"),
  ],
  Iosevka: () => [
    import("@fontsource/iosevka/400.css"),
    import("@fontsource/iosevka/700.css"),
  ],
  "Source Code Pro": () => [
    import("@fontsource/source-code-pro/400.css"),
    import("@fontsource/source-code-pro/700.css"),
  ],
  "Commit Mono": () => [
    import("@fontsource/commit-mono/400.css"),
    import("@fontsource/commit-mono/700.css"),
  ],
  "Geist Mono": () => [
    import("@fontsource/geist-mono/400.css"),
    import("@fontsource/geist-mono/700.css"),
  ],
  "Intel One Mono": () => [
    import("@fontsource/intel-one-mono/400.css"),
    import("@fontsource/intel-one-mono/700.css"),
  ],
}));

/** Every family named in a CSS stack (or a bare family name), unquoted. */
function familiesOf(stack: string): string[] {
  return stack
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * The bundled families these preferences name, in preference order and once
 * each: the terminal's stack, the code font, the interface font. Installed
 * fonts and the defaults name none.
 */
export function bundledFamiliesFor(prefs: {
  fontFamily: string;
  codeFontFamily: string;
  uiFontFamily: string;
}): string[] {
  const named = [prefs.fontFamily, prefs.codeFontFamily, prefs.uiFontFamily].flatMap(familiesOf);
  return [...new Set(named.filter((family) => FAMILY_CSS.has(family)))];
}

const loaded = new Map<string, Promise<void>>();

/** Loads the named bundled families' rules; idempotent per family. */
export function loadBundledFamilies(families: readonly string[]): Promise<void> {
  return Promise.all(
    families.map((family) => {
      let once = loaded.get(family);
      if (!once) {
        const sheets = FAMILY_CSS.get(family);
        once = sheets ? Promise.all(sheets()).then(() => undefined) : Promise.resolve();
        loaded.set(family, once);
      }
      return once;
    }),
  ).then(() => undefined);
}

/**
 * Loads every bundled family. For a picker that previews each family in its
 * own face; the boot only loads what the preferences name
 * (`bundledFamiliesFor`).
 */
export function loadBundledFonts(): Promise<void> {
  return loadBundledFamilies(BUNDLED_FONTS.map((f) => f.family));
}
