/**
 * The Symbols icon theme — the real one, by Miguel Solorio.
 *
 * Everything in `icons/`, `theme.json` and `LICENSE` is vendored verbatim
 * from https://github.com/miguelsolorio/vscode-symbols (MIT, © Miguel
 * Solorio), version pinned in `lib/extensions.ts`. This module only ports the
 * lookup VS Code does with the same JSON: exact file name first, then every
 * dotted suffix longest-first (`a.test.ts` tries `test.ts` before `ts`),
 * then the theme's default document; folders go by name with one icon for
 * open and closed, because that is how Symbols itself ships.
 *
 * The whole thing — 354 SVGs plus the maps — loads as a lazy chunk: the
 * `import()` in `FileGlyph` only happens with the extension turned on, so a
 * profile that never enables it never downloads an icon.
 */
import theme from "./theme.json";

interface SymbolsTheme {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  file: string;
  folder: string;
}

const t = theme as unknown as SymbolsTheme;

// `?url`: each SVG stays a file (or data URI) and the <img> below points at
// it — the icons carry their own colors, nothing here needs to tint them.
const URLS = import.meta.glob<string>("./icons/*/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

/**
 * The JSON mixes cases (and even ships duplicate keys differing only in
 * case), while our lookup normalizes to lowercase — fold the maps once.
 */
function folded(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k.toLowerCase()] = v;
  return out;
}

const FILE_NAMES = folded(t.fileNames);
const FILE_EXTS = folded(t.fileExtensions);
const FOLDER_NAMES = folded(t.folderNames);

function urlOf(def: string | undefined): string | null {
  const path = def ? t.iconDefinitions[def]?.iconPath : undefined;
  return (path && URLS[path]) || null;
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

export function folderIconUrl(name: string): string | null {
  return urlOf(FOLDER_NAMES[name.toLowerCase()]) ?? urlOf(t.folder);
}

interface Props {
  name: string;
  dir?: boolean;
  size?: number;
}

/** Default export so `FileGlyph` can `lazy()` the whole theme in. */
export default function SymbolIcon({ name, dir, size = 13 }: Props) {
  const src = dir ? folderIconUrl(name) : fileIconUrl(name);
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
