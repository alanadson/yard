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
  /** There is unsaved text, so the draft and the disk differ. */
  dirty: boolean;
  /** The project is a git repository, so there is a HEAD to compare against. */
  git: boolean;
  /** The ending the next save will write. The buffer itself is always LF. */
  eolCrlf: boolean;
  /** The encoding the file was read with (`src-tauri/src/encoding.rs`). */
  encoding: string;
}

export interface FileMenuActions {
  toggleWrap: () => void;
  openExternal: () => void;
  /** Opens the diff of this file against the last commit. */
  compareHead: () => void;
  /** Opens the diff of the draft against what is on disk. */
  compareSaved: () => void;
  /** Chooses the ending the next save writes (`lib/eol.ts`). */
  setEol: (crlf: boolean) => void;
  /** Re-reads the file in another encoding, throwing away any draft. */
  reopenWith: (encoding: string) => void;
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

  // Both comparisons already existed, and only from the Source control tab:
  // to see what you had changed in the file in front of you, you had to go
  // find it in a list somewhere else. They are questions about the document,
  // so they belong to the document's own menu.
  //
  // Each appears only when it has an answer. A picture has no lines, a
  // project without git has no HEAD, and a file with no draft would compare
  // two copies of the same text.
  const compare: MenuEntry[] = [];
  if (!view.media) {
    if (view.git) {
      compare.push({
        id: "diff-head",
        label: t("Comparar com o HEAD"),
        onSelect: act.compareHead,
      });
    }
    if (view.dirty) {
      compare.push({
        id: "diff-saved",
        label: t("Comparar com o salvo"),
        onSelect: act.compareSaved,
      });
    }
  }

  // A pair of choices rather than a switch: "CRLF" and "LF" are the words
  // the reader already has, and a switch would have to be labelled with one
  // of them anyway.
  const eol: MenuEntry[] = view.media
    ? []
    : [
        { kind: "sep" },
        {
          id: "eol-lf",
          label: t("Terminação LF"),
          checked: !view.eolCrlf,
          onSelect: () => act.setEol(false),
        },
        {
          id: "eol-crlf",
          label: t("Terminação CRLF"),
          checked: view.eolCrlf,
          onSelect: () => act.setEol(true),
        },
      ];

  // A submenu rather than four more rows: the least used control on this
  // menu, with the most options, and whoever needs it knows the word they are
  // looking for. Nothing here is guessed: UTF-16 announces itself with a BOM
  // and is picked up on its own, and Windows-1252 decodes *any* byte sequence
  // at all, so it can only ever be chosen by hand. This is the hand.
  const encodings: MenuEntry[] = view.media
    ? []
    : [
        {
          id: "codificacao",
          label: t("Reabrir com a codificação"),
          submenu: ENCODINGS.map(([id, label]) => ({
            id: `enc-${id}`,
            label,
            checked: view.encoding === id,
            onSelect: () => act.reopenWith(id),
          })),
        },
      ];

  return [
    ...own,
    ...(compare.length ? [{ kind: "sep" } as MenuEntry, ...compare] : []),
    ...eol,
    ...encodings,
    { kind: "sep" },
    ...tab,
  ];
}

/**
 * The four the backend can read and write. Their names are not sentences and
 * not translated: `UTF-8` is `UTF-8` in every language, and a reader looking
 * for one of these is looking for exactly this string.
 */
const ENCODINGS: readonly (readonly [string, string])[] = [
  ["utf-8", "UTF-8"],
  ["utf-16le", "UTF-16 LE"],
  ["utf-16be", "UTF-16 BE"],
  ["windows-1252", "Windows-1252"],
];

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
