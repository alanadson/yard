/**
 * The title bar's context menu — the window menu the custom decoration took
 * out of the picture.
 *
 * The bar is the app's largest dead surface: outside the buttons it only
 * serves to drag the window, and right-clicking there gave nothing back.
 * What it gives back now is the map of the application: the four panels
 * (with each one's state on show and the shortcut next to it), the three
 * settings screens and the two window actions.
 */
import type { ModalKind } from "../stores/uiStore";
import type { MenuEntry } from "../components/ContextMenu";

export interface TitleBarMenuActions {
  toggleSidebar: () => void;
  toggleChanges: () => void;
  toggleBench: () => void;
  toggleNotes: () => void;
  openModal: (modal: ModalKind) => void;
  toggleMaximize: () => void;
  minimize: () => void;
}

export interface TitleBarMenuContext {
  sidebar: boolean;
  changes: boolean;
  bench: boolean;
  notes: boolean;
  maximized: boolean;
}

export function titleBarMenu(
  ctx: TitleBarMenuContext,
  act: TitleBarMenuActions,
): MenuEntry[] {
  return [
    {
      id: "sidebar",
      label: "Barra lateral",
      // Checked, not hidden: the menu is the indicator of what is open.
      checked: ctx.sidebar,
      shortcut: "Ctrl+B",
      onSelect: act.toggleSidebar,
    },
    {
      id: "changes",
      label: "Arquivos e alterações",
      checked: ctx.changes,
      shortcut: "Ctrl+Shift+D",
      onSelect: act.toggleChanges,
    },
    {
      id: "bench",
      label: "Bancada",
      checked: ctx.bench,
      shortcut: "Ctrl+Shift+B",
      onSelect: act.toggleBench,
    },
    {
      id: "notes",
      label: "Anotações",
      checked: ctx.notes,
      shortcut: "Ctrl+Shift+N",
      onSelect: act.toggleNotes,
    },
    { kind: "sep" },
    { id: "prefs", label: "Preferências…", shortcut: "Ctrl+,", onSelect: () => act.openModal("preferences") },
    { id: "extensions", label: "Extensões…", onSelect: () => act.openModal("extensions") },
    {
      id: "shortcuts",
      label: "Atalhos",
      shortcut: "Ctrl+Shift+H",
      onSelect: () => act.openModal("shortcuts"),
    },
    { kind: "sep" },
    {
      id: "maximize",
      // Saying "Maximize" on a maximized window lies about the click.
      label: ctx.maximized ? "Restaurar" : "Maximizar",
      onSelect: act.toggleMaximize,
    },
    { id: "minimize", label: "Minimizar", onSelect: act.minimize },
  ];
}
