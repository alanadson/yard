/**
 * The pane's context menu: the tab bar outside the tabs, the empty pane and
 * the "no terminal in this group" area.
 *
 * The tab had a menu; the pane around it did not — and that is precisely
 * where the click of someone who wants to **open** something lands, because
 * the tab they are looking for does not exist yet. The first two entries are
 * the two buttons the empty pane already shows; the difference is that now
 * they also exist when the pane is full.
 */
import type { MenuEntry } from "../components/ContextMenu";
import type { LayoutMode } from "../stores/projectsStore";

export interface PaneMenuActions {
  newCli: () => void;
  newBrowser: () => void;
  /** Docks the notebook as a tab of this pane. */
  dockNotes: () => void;
  setMode: (mode: LayoutMode) => void;
}

export interface PaneMenuContext {
  mode: LayoutMode;
  /** The notebook is already a tab of this pane — it only docks in one place at a time. */
  notesHere: boolean;
}

const MODES: { id: LayoutMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "grid", label: "Grade" },
  { id: "spotlight", label: "Holofote" },
  { id: "canvas", label: "Canvas" },
];

export function paneMenu(ctx: PaneMenuContext, act: PaneMenuActions): MenuEntry[] {
  return [
    { id: "cli", label: "Nova CLI aqui", shortcut: "Ctrl+T", onSelect: act.newCli },
    { id: "browser", label: "Novo navegador aqui", onSelect: act.newBrowser },
    {
      id: "notas",
      label: "Anotações aqui",
      // One notebook, one place: offering to dock where it already is would
      // be an entry that changes nothing on screen.
      disabled: ctx.notesHere,
      onSelect: act.dockNotes,
    },
    { kind: "sep" },
    {
      // Separated from the ones above on purpose: the first three open
      // things in *this* pane; this one changes the shape of the whole group.
      id: "modo",
      label: "Layout do grupo",
      submenu: MODES.map((m) => ({
        id: `modo-${m.id}`,
        label: m.label,
        checked: ctx.mode === m.id,
        onSelect: () => act.setMode(m.id),
      })),
    },
  ];
}
