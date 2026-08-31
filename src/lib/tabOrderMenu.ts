/**
 * The rows about a tab's *place* in its bar: fix it at the front, walk it one
 * step to either side.
 *
 * One builder for the four kinds of tab the bar paints (CLI, file, browser,
 * notebook), because they come from three different stores and a command that
 * exists on the CLI but not on the browser beside it reads as a bug. Each
 * store supplies only the doing; the wording, the shortcut and — the part
 * worth centralising — *when the command is greyed out* are decided here.
 *
 * Greying out is not decoration: the ends of the bar are walls, and so is the
 * line between the pinned half and the loose one. A row that silently does
 * nothing leaves the user unable to tell a broken command from a wall.
 */
import { stepInBar, type TabRef } from "./paneBar";
import type { MenuEntry } from "../components/ContextMenu";
import { t } from "./i18n";

export interface TabOrderTarget {
  id: string;
  pinned: boolean;
}

export interface TabOrderActions {
  togglePin: (id: string) => void;
  /** One step along the bar. `null` bar means the host has no bar to walk. */
  moveBy?: (id: string, dir: -1 | 1) => void;
}

/**
 * `bar` is the pane's whole bar, in the order it is painted (`lib/paneBar.ts`)
 * — every kind, interleaved, because that is what the step walks along: the
 * tab a CLI trades places with is usually a file. `null` when the host shows
 * one tab at a time (the overlay editor's header), and then only the pin is
 * offered.
 */
export function tabOrderMenu(
  target: TabOrderTarget,
  bar: readonly TabRef[] | null,
  act: TabOrderActions,
): MenuEntry[] {
  const pin: MenuEntry = {
    id: "fixar",
    label: target.pinned ? t("Desafixar") : t("Fixar"),
    onSelect: () => act.togglePin(target.id),
  };
  const move = act.moveBy;
  if (!bar || !move) return [pin];
  return [
    pin,
    {
      id: "mover-esq",
      label: t("Mover para a esquerda"),
      shortcut: "Ctrl+Shift+←",
      disabled: !stepInBar(bar, target.id, -1),
      onSelect: () => move(target.id, -1),
    },
    {
      id: "mover-dir",
      label: t("Mover para a direita"),
      shortcut: "Ctrl+Shift+→",
      disabled: !stepInBar(bar, target.id, 1),
      onSelect: () => move(target.id, 1),
    },
  ];
}
