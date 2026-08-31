/**
 * The context menu of the file tab.
 *
 * The tab closed through the X, middle-click and Ctrl+W — and had no menu at
 * all. The rest of what any tabbed editor offers was missing: close the
 * others, close to the right, copy the path, show in folder.
 *
 * The decision this module carries is about reach. "The others" and "to the
 * right" depend on the position in the bar; save depends on there being a
 * draft **and** on the file accepting writes (binary, truncated or lossily
 * decoded opens read-only on purpose — writing over it would cut off the rest).
 */
import { toOsPath } from "./paths";
import { tabOrderMenu } from "./tabOrderMenu";
import type { TabRef } from "./paneBar";
import type { MenuEntry } from "../components/ContextMenu";
import { t } from "./i18n";

export interface EditorTabMenuActions {
  close: (id: string) => void;
  closeMany: (ids: string[]) => void;
  /**
   * The crowd commands. They go to the store rather than being computed here,
   * because "the others" now has an exception the menu cannot see: a pinned
   * tab (`lib/tabRules.ts`).
   */
  closeScoped: (id: string, scope: "others" | "right" | "saved") => void;
  togglePin: (id: string) => void;
  /**
   * One step along the bar. Absent in the overlay editor's header, which
   * shows a document at a time and has no bar to walk.
   */
  moveBy?: (id: string, dir: -1 | 1) => void;
  save: (id: string) => void;
  reload: (id: string) => void;
  copyPath: (text: string) => void;
  reveal: (osPath: string) => void;
  /** Opens the tree on the file and scrolls it into view. */
  revealInTree: (path: string) => void;
  rename: (path: string) => void;
  remove: (path: string) => void;
}

export interface EditorTabMenuTarget {
  id: string;
  /** Relative to the root, with `/`. */
  path: string;
  root: string;
  dirty: boolean;
  /** Kept at the front of the bar, and out of every crowd close. */
  pinned: boolean;
  /** Binary, truncated or lossy — the editor opened it just to read. */
  readOnly: boolean;
  /** Vanished from disk externally. */
  missing: boolean;
  /** A comparison (the diff opened as a tab), not a file: nothing on disk to reload. */
  comparison?: boolean;
}

/** The tabs in bar order — what gives "to the right" its meaning. */
export interface EditorTabRef {
  id: string;
  path: string;
}

export function editorTabMenu(
  target: EditorTabMenuTarget,
  tabs: readonly EditorTabRef[],
  act: EditorTabMenuActions,
  /**
   * The pane's whole bar, in the order it is painted — every kind of tab,
   * which is what "one place to the left" is measured against. Absent where
   * there is no bar (the overlay header), and then only the pin shows up.
   */
  bar: readonly TabRef[] | null = null,
): MenuEntry[] {
  const position = tabs.findIndex((d) => d.id === target.id);
  const others = tabs.filter((d) => d.id !== target.id).map((d) => d.id);
  const rightSide = position < 0 ? [] : tabs.slice(position + 1).map((d) => d.id);
  const absolutePath = toOsPath(target.root, target.path);
  // A comparison has no file of its own to reveal, rename or delete: it is a
  // question about a file, drawn from git.
  const fileRows: MenuEntry[] = target.comparison
    ? []
    : [
        { kind: "sep" },
        {
          id: "arvore",
          label: t("Revelar na árvore"),
          onSelect: () => act.revealInTree(target.path),
        },
        {
          id: "renomear",
          label: t("Renomear…"),
          disabled: target.missing,
          onSelect: () => act.rename(target.path),
        },
        {
          id: "excluir",
          label: t("Excluir…"),
          disabled: target.missing,
          onSelect: () => act.remove(target.path),
        },
      ];
  return [
    { id: "fechar", label: t("Fechar"), shortcut: "Ctrl+W", onSelect: () => act.close(target.id) },
    {
      id: "outras",
      label: t("Fechar as outras"),
      disabled: others.length === 0,
      onSelect: () => act.closeScoped(target.id, "others"),
    },
    {
      id: "direita",
      label: t("Fechar as da direita"),
      disabled: rightSide.length === 0,
      onSelect: () => act.closeScoped(target.id, "right"),
    },
    {
      id: "salvas",
      label: t("Fechar as salvas"),
      onSelect: () => act.closeScoped(target.id, "saved"),
    },
    { kind: "sep" },
    // Pin and "move one place" come from the builder every kind of tab shares
    // (`lib/tabOrderMenu.ts`): a file, a CLI and a page sit in the same bar
    // and must not disagree about what can be done to their place in it.
    ...tabOrderMenu({ id: target.id, pinned: target.pinned }, bar, act),
    { kind: "sep" },
    {
      id: "salvar",
      label: t("Salvar"),
      shortcut: "Ctrl+S",
      // Without a draft there is nothing to write; read-only never writes.
      disabled: !target.dirty || target.readOnly,
      onSelect: () => act.save(target.id),
    },
    {
      id: "recarregar",
      label: t("Recarregar do disco"),
      disabled: target.missing || !!target.comparison,
      onSelect: () => act.reload(target.id),
    },
    { kind: "sep" },
    { id: "copiar", label: t("Copiar caminho"), onSelect: () => act.copyPath(target.path) },
    {
      id: "copiar-abs",
      label: t("Copiar caminho completo"),
      onSelect: () => act.copyPath(absolutePath),
    },
    {
      id: "revelar",
      label: t("Mostrar na pasta"),
      disabled: target.missing,
      onSelect: () => act.reveal(absolutePath),
    },
    ...fileRows,
  ];
}
