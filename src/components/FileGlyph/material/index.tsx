/**
 * The Material Icon Theme — the real one, by Philipp Kief.
 *
 * `theme.json` and `LICENSE` are vendored verbatim from the npm package
 * `material-icon-theme` (MIT, © Philipp Kief), version pinned in
 * `lib/extensions.ts`. The 1250 SVGs live in `public/material-icons/`
 * (LICENSE alongside) and are served as plain static files instead of being
 * bundled: at 3.5× the Symbols count, inlining them would turn the lazy
 * chunk into a several-MB parse — as URLs, only the icons actually on screen
 * ever load. This module carries just the maps (~450KB, still lazy).
 *
 * The lookup is VS Code's, same as the Symbols port: exact file name, then
 * every dotted suffix longest-first, then the default document. Folders have
 * what Symbols lacks — an expanded variant (`folderNamesExpanded`).
 */
import theme from "./theme.json";

interface MaterialTheme {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

const t = theme as unknown as MaterialTheme;

/** Case-folded copies of the maps — the JSON mixes cases, our lookup doesn't. */
function folded(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k.toLowerCase()] = v;
  return out;
}

const FILE_NAMES = folded(t.fileNames);
const FILE_EXTS = folded(t.fileExtensions);
const FOLDER_NAMES = folded(t.folderNames);
const FOLDER_NAMES_OPEN = folded(t.folderNamesExpanded);

/** `./../icons/git.svg` in the JSON → the static route the app serves. */
function urlOf(def: string | undefined): string | null {
  const path = def ? t.iconDefinitions[def]?.iconPath : undefined;
  if (!path) return null;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return `/material-icons/${base}`;
}

export function fileIconUrl(name: string): string | null {
  const lower = name.toLowerCase();
  const exact = urlOf(FILE_NAMES[lower]);
  if (exact) return exact;
  let dot = lower.indexOf(".");
  while (dot !== -1) {
    const hit = urlOf(FILE_EXTS[lower.slice(dot + 1)]);
    if (hit) return hit;
    dot = lower.indexOf(".", dot + 1);
  }
  return urlOf(t.file);
}

export function folderIconUrl(name: string, expanded?: boolean): string | null {
  const lower = name.toLowerCase();
  if (expanded) {
    return urlOf(FOLDER_NAMES_OPEN[lower]) ?? urlOf(t.folderExpanded);
  }
  return urlOf(FOLDER_NAMES[lower]) ?? urlOf(t.folder);
}

interface Props {
  name: string;
  dir?: boolean;
  expanded?: boolean;
  size?: number;
}

/** Default export so `FileGlyph` can `lazy()` the whole theme in. */
export default function MaterialIcon({ name, dir, expanded, size = 13 }: Props) {
  const src = dir ? folderIconUrl(name, expanded) : fileIconUrl(name);
  if (!src) return null;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: "block" }}
    />
  );
}
