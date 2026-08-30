/**
 * Where the line marks are drawn.
 *
 * Not in a gutter of its own: a strip that is empty in nine files out of ten
 * still indents all ten, and this window has spent a lot of effort on not
 * having furniture. `gutterLineClass` puts a class on the gutter elements of
 * a line across every gutter there is, so the mark lands on the **line
 * number itself** and costs no width at all.
 *
 * The marks are stored as bare line numbers and the file underneath them
 * belongs to other people, an agent rewriting it, a reload from disk. A
 * number pointing past the end of the text is normal, and `doc.line()` throws
 * on one, so the translation from lines to offsets is a function of its own
 * with a test on it.
 */
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import { EditorView, gutterLineClass, GutterMarker } from "@codemirror/view";

/** The marks of the document on screen, as 0-based lines. */
export const setBookmarks = StateEffect.define<readonly number[]>();

class BookmarkMarker extends GutterMarker {
  override elementClass = "cm-bookmark";
}

const bookmark = new BookmarkMarker();

/**
 * The document offsets `lines` point at, in ascending order. Lines outside
 * the document are dropped rather than clamped: a mark on a line that no
 * longer exists is a mark that is gone, not one that moved to the end.
 */
export function bookmarkOffsets(lines: readonly number[], doc: Text): number[] {
  const offsets: number[] = [];
  for (const line of lines) {
    if (line < 0 || line >= doc.lines) continue;
    offsets.push(doc.line(line + 1).from);
  }
  return offsets.sort((a, b) => a - b);
}

function buildSet(lines: readonly number[], doc: Text): RangeSet<GutterMarker> {
  const offsets = bookmarkOffsets(lines, doc);
  if (offsets.length === 0) return RangeSet.empty;
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const at of offsets) builder.add(at, at, bookmark);
  return builder.finish();
}

const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    // Between two `setBookmarks` the marks ride along with the text, so
    // typing above one does not leave it behind on the wrong line.
    if (tr.docChanged) value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBookmarks)) value = buildSet(e.value, tr.state.doc);
    return value;
  },
});

const bookmarkTheme = EditorView.baseTheme({
  ".cm-bookmark": {
    color: "var(--accent-bright)",
    fontWeight: "600",
  },
});

/** Ready to drop into the editor's extension list. */
export const bookmarkExt = [
  bookmarkField,
  gutterLineClass.from(bookmarkField),
  bookmarkTheme,
];

/** Pushes the document's marks into a live view. */
export function applyBookmarks(view: EditorView, lines: readonly number[]): void {
  view.dispatch({ effects: setBookmarks.of(lines) });
}
