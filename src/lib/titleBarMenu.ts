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
import { t } from "./i18n";

export interface TitleBarMenuActions {
  toggleSidebar: () => void;
  toggleChanges: () => void;
  toggleBench: () => void;
  toggleNotes: () => void;
  toggleStatusBar: () => void;
  openModal: (modal: ModalKind) => void;
  toggleMaximize: () => void;
  minimize: () => void;
}

export interface TitleBarMenuContext {
  sidebar: boolean;
  changes: boolean;
  bench: boolean;
  notes: boolean;
  /** The footer (`StatusBar`) — hidden from Settings, shown again from here. */
  statusBar: boolean;
  maximized: boolean;
}

export function titleBarMenu(
  ctx: TitleBarMenuContext,
  act: TitleBarMenuActions,
): MenuEntry[] {
  return [
    {
      id: "sidebar",
      label: t("Barra lateral"),
      // Checked, not hidden: the menu is the indicator of what is open.
      checked: ctx.sidebar,
      shortcut: "Ctrl+B",
      onSelect: act.toggleSidebar,
    },
    {
      id: "changes",
      label: t("Arquivos e alterações"),
      checked: ctx.changes,
      shortcut: "Ctrl+Shift+D",
      onSelect: act.toggleChanges,
    },
    {
      id: "bench",
      label: t("Bancada"),
      checked: ctx.bench,
      shortcut: "Ctrl+Shift+B",
      onSelect: act.toggleBench,
    },
    {
      id: "notes",
      label: t("Anotações"),
      checked: ctx.notes,
      shortcut: "Ctrl+Shift+N",
      onSelect: act.toggleNotes,
    },
    {
      id: "statusbar",
      label: "Barra de status",
      checked: ctx.statusBar,
      onSelect: act.toggleStatusBar,
    },
    { kind: "sep" },
    { id: "prefs", label: t("Preferências…"), shortcut: "Ctrl+,", onSelect: () => act.openModal("preferences") },
    {
      id: "shortcuts",
      label: t("Atalhos"),
      shortcut: "Ctrl+Shift+H",
      onSelect: () => act.openModal("shortcuts"),
    },
    { kind: "sep" },
    {
      id: "maximize",
      // Saying "Maximize" on a maximized window lies about the click.
      label: ctx.maximized ? t("Restaurar") : t("Maximizar"),
      onSelect: act.toggleMaximize,
    },
    { id: "minimize", label: t("Minimizar"), onSelect: act.minimize },
  ];
}
