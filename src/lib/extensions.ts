/**
 * The ids of everything that ships with the Yard switched off.
 *
 * This used to be a shop window: a name, an author, a licence, a paragraph
 * and a live preview per entry, drawn as cards on a shelf of its own
 * (`Ctrl+Shift+X`). The shelf is gone — a feature that ships with the app is a
 * setting, and it now sits on the Settings page of the surface it changes,
 * with its own sentence written where it is drawn. What is left here is the
 * part no screen can own:
 *
 * - **which ids exist**, because that is the filter every profile is read
 *   through (`parseEnabled`): an id that leaves this list is a switch quietly
 *   forgotten the next time the app opens;
 * - **which of them take turns**, because two icon themes (or two colour
 *   schemes) at once would both claim the same surface.
 *
 * The colour schemes are here for the first reason only. They are remembered
 * in `ext.scheme` today (`lib/schemeChoice.ts`), but every profile written
 * before that split still keeps one as a boolean in `ext.enabled`, and the
 * migration reads it through this list.
 */
import { SCHEME_IDS } from "./colorSchemes";

export type ExtensionId =
  | "symbols"
  | "material-icons"
  | "code-fonts"
  | "rainbow-brackets"
  | "todo-highlight"
  | "minimap"
  | "indent-guides"
  | "css-colors"
  | "format-on-save"
  | "term-images"
  | "mermaid"
  | "katex"
  | "theme-dracula"
  | "theme-nord"
  | "theme-catppuccin"
  | "theme-tokyo-night"
  | "theme-rose-pine"
  | "theme-solarized"
  | "theme-one-dark"
  | "theme-ayu"
  | "theme-github-dark"
  | "theme-min-dark";

export interface ExtensionDef {
  id: ExtensionId;
  /**
   * Ids in the same category exclude each other: turning one on turns its
   * siblings off. Absent = an independent switch.
   */
  category?: "icon-theme" | "color-theme";
}

/** The palettes, as ids. Which of them paints what lives in `ext.scheme`. */
const SCHEMES: ExtensionDef[] = SCHEME_IDS.map((id) => ({
  id: id as ExtensionId,
  category: "color-theme" as const,
}));

export const EXTENSIONS: readonly ExtensionDef[] = [
  // The two file icon themes. One slot: the picker that chooses between them
  // is in Ajustes → Editor de código (`lib/iconTheme.ts`).
  { id: "symbols", category: "icon-theme" },
  { id: "material-icons", category: "icon-theme" },
  ...SCHEMES,
  // Interface → Fontes.
  { id: "code-fonts" },
  // Editor de código → Recursos do editor.
  { id: "rainbow-brackets" },
  { id: "todo-highlight" },
  { id: "minimap" },
  { id: "indent-guides" },
  { id: "css-colors" },
  { id: "format-on-save" },
  // Terminal → Recursos do terminal.
  { id: "term-images" },
  // Editor de código → Markdown.
  { id: "mermaid" },
  { id: "katex" },
];
