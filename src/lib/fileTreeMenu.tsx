/**
 * The context menu of the file tree — the row and the background.
 *
 * The rows already had a menu; the background returned an empty list, and a
 * menu that opens with nothing inside is worse than no menu. In a project
 * with few files, the background is half the panel.
 *
 * The decision worth isolating here is *where the new thing is born*: on a
 * folder, inside it; on a file, in the folder that contains it (creating
 * inside a file does not exist); on the background, at the root.
 */
import { Copy, FilePlus, FolderOpen, FolderPlus, Pencil, RotateCw, Trash2 } from "lucide-react";

import { toOsPath } from "./paths";
import type { MenuEntry } from "../components/ContextMenu";
import { t } from "./i18n";

/** What the menu needs to know about the clicked row. */
export interface FileTreeMenuEntry {
  name: string;
  /** Relative to the root, with `/`. */
  path: string;
  dir: boolean;
}

export interface FileTreeMenuActions {
  /** Opens the name field for a new file (or folder) inside `dir`. */
  draft: (dir: string, isDir: boolean) => void;
  rename: (path: string) => void;
  copyPath: (path: string) => void;
  reveal: (osPath: string) => void;
  /** Asks and deletes — the confirmation belongs to the caller, which has the dialog. */
  remove: (entry: FileTreeMenuEntry) => void;
  refresh: () => void;
}

/** The folder a new thing is born in when `entry` is clicked. */
function targetFolder(entry: FileTreeMenuEntry | null): string {
  if (!entry) return "";
  if (entry.dir) return entry.path;
  const cut = entry.path.lastIndexOf("/");
  return cut < 0 ? "" : entry.path.slice(0, cut);
}

export function fileTreeMenu(
  entry: FileTreeMenuEntry | null,
  root: string,
  act: FileTreeMenuActions,
): MenuEntry[] {
  const dir = targetFolder(entry);
  const items: MenuEntry[] = [
    {
      id: "new-file",
      label: t("Novo arquivo"),
      icon: <FilePlus size={13} />,
      onSelect: () => act.draft(dir, false),
    },
    {
      id: "new-dir",
      label: t("Nova pasta"),
      icon: <FolderPlus size={13} />,
      onSelect: () => act.draft(dir, true),
    },
    { kind: "sep" },
  ];

  if (entry) {
    items.push(
      {
        id: "rename",
        label: t("Renomear…"),
        icon: <Pencil size={13} />,
        onSelect: () => act.rename(entry.path),
      },
      {
        id: "copy",
        label: t("Copiar caminho"),
        icon: <Copy size={13} />,
        onSelect: () => act.copyPath(entry.path),
      },
      {
        id: "reveal",
        label: t("Mostrar no Explorer"),
        icon: <FolderOpen size={13} />,
        onSelect: () => act.reveal(toOsPath(root, entry.path)),
      },
      { kind: "sep" },
      {
        id: "delete",
        label: t("Excluir…"),
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => act.remove(entry),
      },
    );
    return items;
  }

  // With no row clicked, the target is the project. Rename and delete stay
  // out: there is nothing to rename, and "Excluir…" with no target is a scare
  // waiting to happen.
  items.push(
    {
      id: "copy",
      label: t("Copiar caminho do projeto"),
      icon: <Copy size={13} />,
      onSelect: () => act.copyPath(root),
    },
    {
      id: "reveal",
      label: t("Mostrar no Explorer"),
      icon: <FolderOpen size={13} />,
      onSelect: () => act.reveal(root),
    },
    { kind: "sep" },
    {
      id: "refresh",
      label: t("Reler a pasta do disco"),
      icon: <RotateCw size={13} />,
      onSelect: act.refresh,
    },
  );
  return items;
}
