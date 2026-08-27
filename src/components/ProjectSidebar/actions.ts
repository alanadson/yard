/**
 * What the sidebar's action rows say.
 *
 * The rows at the top of the bar are the app's doors that belong to no
 * project: an icon at the left and the name beside it. Unlike a square in the
 * title bar, the row is not anonymous, so the balloon no longer has to spell
 * out which panel this is. What it does still carry is the shortcut: printed
 * in the row it would be a second line of chrome to read on every glance, for
 * something learnt once, and in the balloon it is one hover away, exactly
 * where the rest of the app keeps it.
 *
 * The name stays the same in both states (`aria-pressed` is what tells a
 * screen reader whether it is open, and a name that flips would announce a
 * different row each time) and the balloon names the action by state.
 */
import { t } from "../../lib/i18n";

export interface SidebarActionState {
  /** Whether the notebook is on screen right now. */
  open: boolean;
}

export interface SidebarActionLabel {
  /** The name printed in the row, stable across states. */
  label: string;
  /** The balloon: the action by state, plus the shortcut. */
  tip: string;
}

const NOTES_KEY = "Ctrl+Shift+N";

export function notesAction(state: SidebarActionState): SidebarActionLabel {
  const key = NOTES_KEY;
  return {
    label: t("Anotações"),
    tip: state.open
      ? t("Esconder as anotações ({key})", { key })
      : t("Mostrar as anotações, o caderno markdown ({key})", { key }),
  };
}

/**
 * The other door with no project: the app's own settings, at the foot of the
 * bar. It has no open/closed state to report (it opens a sheet over
 * everything), so the balloon's job here is only the shortcut.
 */
export function settingsAction(): SidebarActionLabel {
  return {
    label: t("Configurações"),
    tip: t("Abrir as configurações ({key})", { key: "Ctrl+Shift+P" }),
  };
}
