/**
 * The code fonts the "Fontes de código" extension ships — all OFL 1.1, all
 * packaged via Fontsource (the repo rule: every resource bundled, nothing
 * fetched at runtime — §DESIGN "empacotar todo recurso").
 *
 * The CSS files are imported dynamically, so the woff2 payload stays out of
 * every profile that never turns the extension on. Loading is idempotent and
 * the `@font-face` rules stay for the session once in — a font that vanished
 * mid-session would leave the terminal measuring a family that no longer
 * resolves.
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

let promise: Promise<void> | null = null;

/** Loads every family's @font-face rules (400/700; Victor keeps its italic). */
export function loadBundledFonts(): Promise<void> {
  return (promise ??= Promise.all([
    import("@fontsource/jetbrains-mono/400.css"),
    import("@fontsource/jetbrains-mono/700.css"),
    import("@fontsource/fira-code/400.css"),
    import("@fontsource/fira-code/700.css"),
    import("@fontsource/victor-mono/400.css"),
    import("@fontsource/victor-mono/400-italic.css"),
    import("@fontsource/victor-mono/700.css"),
    import("@fontsource/ibm-plex-mono/400.css"),
    import("@fontsource/ibm-plex-mono/700.css"),
    import("@fontsource/monaspace-neon/400.css"),
    import("@fontsource/monaspace-neon/700.css"),
    import("@fontsource/iosevka/400.css"),
    import("@fontsource/iosevka/700.css"),
    import("@fontsource/source-code-pro/400.css"),
    import("@fontsource/source-code-pro/700.css"),
    import("@fontsource/commit-mono/400.css"),
    import("@fontsource/commit-mono/700.css"),
    import("@fontsource/geist-mono/400.css"),
    import("@fontsource/geist-mono/700.css"),
    import("@fontsource/intel-one-mono/400.css"),
    import("@fontsource/intel-one-mono/700.css"),
  ]).then(() => undefined));
}
