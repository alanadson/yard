/**
 * The rules of the document header — what sits on the row between the tabs
 * and the text, and what goes into the menu that opens from the path.
 *
 * The header is the file's *title*, not a toolbar: the path (folder dimmed,
 * name lit) is the button, and everything that is about the file as a thing
 * on disk hangs off it. The row itself keeps only how to *look* at the text
 * (modes, outline, search) and the one action that carries state — save,
 * which exists exactly while there is something to save.
 */
import type { MenuEntry } from "../ContextMenu";
import type { MdMode } from "../../stores/editorStore";
import { t } from "../../lib/i18n";

/**
 * The save button is the draft made visible: it appears with the first
 * unsaved keystroke and leaves with the write — but not before the disk
 * answers, or "salvando…" would vanish mid-word.
 */
export function showSave(doc: { readOnly: boolean; dirty: boolean; saving: boolean }): boolean {
  if (doc.readOnly) return false;
  return doc.dirty || doc.saving;
}

export interface FileMenuView {
  wrap: boolean;
  /** The surface is the viewer's (image, video, PDF…), not the text's. */
  media: boolean;
}

export interface FileMenuActions {
  toggleWrap: () => void;
  openExternal: () => void;
}

/**
 * The header's own entries first — they are about *this view* — then the
 * tab's menu verbatim, so the two places a file can be right-clicked never
 * drift apart.
 */
export function fileMenu(
  tab: readonly MenuEntry[],
  view: FileMenuView,
  act: FileMenuActions,
): MenuEntry[] {
  const own: MenuEntry[] = view.media
    ? [{ id: "externo", label: t("Abrir no aplicativo padrão"), onSelect: act.openExternal }]
    : [{ id: "quebra", label: t("Quebra de linha"), checked: view.wrap, onSelect: act.toggleWrap }];
  return [...own, { kind: "sep" }, ...tab];
}

/** What the formatting capsule shows for a given file and mode. */
export interface MdBarSlots {
  /** The capsule exists at all. */
  bar: boolean;
  /** The formatting families — headings, emphasis, lists, inserts, ⋯. */
  formatting: boolean;
  /** The "how to look at the markdown" segmented control, at the end. */
  modes: boolean;
}

/**
 * The mode switcher used to live on the path row, far from the buttons it
 * belongs with; it now rides the capsule as its own slot, after a fillet.
 * That move made the capsule the only door back out of the reading page, so
 * it has to exist there too — showing just the modes, because with the
 * editor gone a formatting button would have nothing to format.
 */
export function mdBar(md: boolean, mode: MdMode): MdBarSlots {
  if (!md) return { bar: false, formatting: false, modes: false };
  return { bar: true, formatting: mode !== "read", modes: true };
}
