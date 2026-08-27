/**
 * The file icon theme, as one choice.
 *
 * Two themes ship with the Yard (`components/FileGlyph`), and they are one
 * slot: both draw over the same tree, the same tabs and the same Busca, so
 * "which one" and "none at all" are three states of a single control. In
 * Ajustes → Editor de código that control is a pop-up button, like the colour
 * theme beside it.
 *
 * The catalog (`lib/extensions.ts`) is still what the store remembers — an id
 * in `ext.enabled` — and it is what the `icon-theme` category excludes
 * siblings by. What lives here is the seam between that pair of switches and
 * a picker that speaks one string: an empty value is the Yard's own glyphs,
 * and a test in `extensions.test.ts` keeps this list and the catalog's
 * category from drifting apart.
 */
import type { ExtensionId } from "./extensions";

export interface IconTheme {
  id: ExtensionId;
  /** The name in the pop-up. A brand: the same word in every language. */
  name: string;
}

/** The themes the picker offers, in the order they appear in it. */
export const ICON_THEMES: readonly IconTheme[] = [
  { id: "symbols", name: "Symbols" },
  { id: "material-icons", name: "Material Icon Theme" },
];

/** Switches, as the store keeps them: absent means off. */
type Enabled = Readonly<Partial<Record<ExtensionId, boolean>>>;

/**
 * Which theme is on, as the picker's value; `""` is the Yard's own glyphs.
 *
 * A hand-edited kv can hold two at once. The store already breaks that tie on
 * the way in, and this breaks it the same way — by list order — because the
 * one thing the picker must never do is answer "none" while the tree is
 * wearing icons.
 */
export function iconThemeValue(enabled: Enabled): string {
  return ICON_THEMES.find((theme) => enabled[theme.id] === true)?.id ?? "";
}

/** The picker's list: the way out first, then every theme. */
export function iconThemeOptions(noneLabel: string): { value: string; label: string }[] {
  return [
    { value: "", label: noneLabel },
    ...ICON_THEMES.map((theme) => ({ value: theme.id, label: theme.name })),
  ];
}

/**
 * What a pick asks the store for, or `null` when nothing has to change.
 *
 * Clearing is the half with no control of its own — "Nenhum" is an entry in a
 * list, not a switch — so it is spelled out here: the theme that is on is
 * named, and turned off. Turning one *on* needs no such care; the store
 * retires the sibling by category.
 */
export function iconThemePick(
  enabled: Enabled,
  value: string,
): { id: ExtensionId; on: boolean } | null {
  const current = iconThemeValue(enabled);
  if (value === current) return null;
  if (value === "") return current === "" ? null : { id: current as ExtensionId, on: false };
  const picked = ICON_THEMES.find((theme) => theme.id === value);
  return picked ? { id: picked.id, on: true } : null;
}
