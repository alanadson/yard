/**
 * The icon of one file or folder, wherever one is drawn — tree row, search
 * result, file tab. Shaped like `TerminalMark`: the call site asks "what is
 * this entry?" and this component answers, so every surface changes together
 * when a theme comes or goes.
 *
 * With no icon theme picked (the default; the picker is in Ajustes → Editor
 * de código → Ícones de arquivo), it draws exactly what the tree always drew:
 * neutral Lucide glyphs, color left to the git state. With one on, the
 * vendored theme takes over — loaded lazily, with the
 * neutral glyph standing in for the frame or two the chunk takes to arrive.
 */
import { lazy, Suspense } from "react";
import {
  File as FileIcon,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image,
} from "lucide-react";

import { useExtensions } from "../../stores/extensionsStore";

const SymbolIcon = lazy(() => import("./symbols"));
const MaterialIcon = lazy(() => import("./material"));

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "kt", "c",
  "h", "cpp", "hpp", "cs", "rb", "php", "swift", "sh", "ps1", "bat", "sql",
  "css", "scss", "html", "vue", "svelte", "toml", "lua", "zig",
]);
const TEXT_EXT = new Set(["md", "txt", "log", "csv", "yml", "yaml", "ini", "cfg", "env"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"]);

/** Icon by extension — all neutral: color here is reserved for git. */
function neutralFile(name: string, size: number) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "json") return <FileJson size={size} />;
  if (CODE_EXT.has(ext)) return <FileCode2 size={size} />;
  if (TEXT_EXT.has(ext)) return <FileText size={size} />;
  if (IMG_EXT.has(ext)) return <Image size={size} />;
  return <FileIcon size={size} />;
}

interface Props {
  name: string;
  dir?: boolean;
  expanded?: boolean;
  size?: number;
}

export function FileGlyph({ name, dir, expanded, size = 13 }: Props) {
  // The category is a radio (see `extensionsStore`), so at most one of these
  // is true — the checks never race each other.
  const symbols = useExtensions((s) => s.enabled.symbols === true);
  const material = useExtensions((s) => s.enabled["material-icons"] === true);
  const neutral = dir ? (
    expanded ? (
      <FolderOpen size={size} />
    ) : (
      <Folder size={size} />
    )
  ) : (
    neutralFile(name, size)
  );
  if (!symbols && !material) return neutral;
  return (
    <Suspense fallback={neutral}>
      {symbols ? (
        <SymbolIcon name={name} dir={dir} size={size} />
      ) : (
        <MaterialIcon name={name} dir={dir} expanded={expanded} size={size} />
      )}
    </Suspense>
  );
}
