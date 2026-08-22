/**
 * The context menu of the files panel — the rows and the background.
 *
 * The panel shows two lists with the same anatomy: the "Ao vivo" feed (what
 * the agents touched this session) and "Alterações" (the `git status`). In
 * both, the row only answered to left-click, and right-click did nothing — so
 * copying the path of a file the agent had just touched meant opening the
 * diff, finding the header and selecting the text by hand.
 *
 * The rule this module carries is not to promise the impossible: a deleted
 * file has nothing to open in the editor and nothing to show in the folder.
 * Even so the entry stays there, dimmed — vanishing moves its neighbors, and
 * the hand already knows where they are.
 */
import { toOsPath } from "./paths";
import type { ChangedFile } from "./ipc";
import type { MenuEntry } from "../components/ContextMenu";

export interface ChangesMenuActions {
  openDiff: (path: string) => void;
  openInEditor: (path: string) => void;
  copyPath: (text: string) => void;
  /** Opens the system file explorer with the file selected. */
  reveal: (osPath: string) => void;
  refresh: () => void;
  clearFeed: () => void;
  close: () => void;
}

export interface ChangedFileMenuContext {
  /** Project (or floor) root — without it the absolute path cannot be built. */
  root: string | null;
  /** The menu belongs to the diff viewer itself: "open the diff" would be an echo. */
  inViewer?: boolean;
}

/** Does the path exist on disk right now? Deleted has nothing to open or reveal. */
function existsOnDisk(f: ChangedFile): boolean {
  return f.status !== "deleted";
}

export function changedFileMenu(
  file: ChangedFile,
  ctx: ChangedFileMenuContext,
  act: ChangesMenuActions,
): MenuEntry[] {
  const onDisk = existsOnDisk(file);
  const absolutePath = ctx.root ? toOsPath(ctx.root, file.path) : null;
  const entries: MenuEntry[] = [
    ...(ctx.inViewer
      ? []
      : [
          {
            id: "diff",
            label: "Abrir o diff",
            onSelect: () => act.openDiff(file.path),
          } satisfies MenuEntry,
        ]),
    {
      id: "editor",
      label: "Abrir no editor",
      // Binary opens in the media viewer, not in the text editor; and the
      // deleted one is no longer there to be opened.
      disabled: !onDisk || file.binary,
      onSelect: () => act.openInEditor(file.path),
    },
    { kind: "sep" },
    {
      id: "copiar",
      label: "Copiar caminho",
      // The relative path is how the repository (and the agent) refer to the file.
      onSelect: () => act.copyPath(file.path),
    },
    {
      id: "copiar-abs",
      label: "Copiar caminho completo",
      disabled: absolutePath === null,
      onSelect: () => absolutePath && act.copyPath(absolutePath),
    },
  ];
  if (file.origPath) {
    entries.push({
      id: "copiar-origem",
      label: "Copiar o caminho de origem",
      onSelect: () => act.copyPath(file.origPath!),
    });
  }
  entries.push({
    id: "revelar",
    label: "Mostrar na pasta",
    disabled: !onDisk || absolutePath === null,
    onSelect: () => absolutePath && act.reveal(absolutePath),
  });
  return entries;
}

export interface ChangesPanelMenuContext {
  tab: "live" | "review";
  /** Is the active folder a git repository? Without that there is nothing to refresh. */
  hasRepo: boolean;
  feedCount: number;
}

/** The panel background: header, tabs, empty space. */
export function changesPanelMenu(
  ctx: ChangesPanelMenuContext,
  act: ChangesMenuActions,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (ctx.tab === "live") {
    entries.push({
      id: "limpar",
      label: "Limpar o feed",
      disabled: ctx.feedCount === 0,
      onSelect: act.clearFeed,
    });
  }
  if (ctx.hasRepo) {
    entries.push({
      id: "atualizar",
      label: "Atualizar (git status)",
      onSelect: act.refresh,
    });
  }
  if (entries.length > 0) entries.push({ kind: "sep" });
  entries.push({
    id: "fechar",
    label: "Fechar o painel",
    shortcut: "Ctrl+Shift+D",
    onSelect: act.close,
  });
  return entries;
}
