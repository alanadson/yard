/**
 * Git gutter — the colored strip beside the line numbers saying how each line
 * stands against HEAD: green born, blue changed, a red wedge where lines died.
 *
 * The comparison is **buffer vs HEAD**, not disk vs HEAD: what was typed and
 * not saved already shows, which is how VS Code behaves and what a person
 * expects mid-edit. The pieces:
 *
 * - `head_text` (Rust) answers what the file looked like at HEAD — `null`
 *   when there is nothing to compare against (untracked, no commit, binary),
 *   and then the gutter simply does not paint;
 * - `diffLines` (lib) computes the marks, debounced while typing;
 * - the `StateField` below holds them as a `RangeSet`, which CodeMirror maps
 *   through document changes on its own — so the marks slide along with the
 *   text between recomputes instead of pointing at the wrong lines.
 */
import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";

import { diffLines, type LineChanges } from "../../lib/lineDiff";
import { hunkAt, peekLines, type Hunk } from "../../lib/hunks";
import { ipc } from "../../lib/ipc";
import { showHunkPeek } from "./hunkPeek";

// ---------------------------------------------------------------------------
// the extension
// ---------------------------------------------------------------------------

/**
 * New marks arrived. `changes: null` means there is nothing to compare
 * against and the strip stays clean.
 *
 * The HEAD text rides along because the calha is no longer only a drawing:
 * clicking a mark shows what the line *was*, and putting it back needs the
 * same text the marks were computed from, not whatever the cache holds by the
 * time the click lands.
 */
export const setGitChanges = StateEffect.define<{
  changes: LineChanges | null;
  head: string | null;
}>();

class ChangeMarker extends GutterMarker {
  constructor(readonly cls: string) {
    super();
    // `elementClass` is what the gutter paints — no `toDOM` needed.
    this.elementClass = cls;
  }
  override eq(other: ChangeMarker) {
    return other.cls === this.cls;
  }
}
/** One shared instance per add/mod/del combination. */
const markerCache = new Map<string, ChangeMarker>();
function marker(cls: string): ChangeMarker {
  let m = markerCache.get(cls);
  if (!m) {
    m = new ChangeMarker(cls);
    markerCache.set(cls, m);
  }
  return m;
}

function buildSet(changes: LineChanges | null, doc: Text): RangeSet<GutterMarker> {
  if (!changes || (changes.marks.size === 0 && changes.deletions.size === 0)) {
    return RangeSet.empty;
  }
  const builder = new RangeSetBuilder<GutterMarker>();
  for (let n = 1; n <= doc.lines; n++) {
    const mark = changes.marks.get(n);
    const delAbove = changes.deletions.has(n);
    // A deletion past the last line hangs from the bottom of the last one.
    const delBelow = n === doc.lines && changes.deletions.has(n + 1);
    if (!mark && !delAbove && !delBelow) continue;
    let cls = mark === "add" ? "cm-git-add" : mark === "mod" ? "cm-git-mod" : "";
    if (delAbove) cls += " cm-git-del";
    if (delBelow) cls += " cm-git-del-below";
    const line = doc.line(n);
    builder.add(line.from, line.from, marker(cls.trim()));
  }
  return builder.finish();
}

const gitField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    if (tr.docChanged) value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setGitChanges)) value = buildSet(e.value.changes, tr.state.doc);
    }
    return value;
  },
});

/**
 * The same marks as runs, with the old lines each one stands for, and the
 * HEAD text to read them out of.
 *
 * Deliberately *not* mapped through document changes: line numbers cannot be
 * mapped honestly, and the marks are recomputed on a debounce anyway. What
 * protects the reader is that every writer of these ranges checks them
 * against the text in hand (`revertHunk`, `peekLines`).
 */
interface GitState {
  hunks: Hunk[];
  head: string | null;
}

const gitHunks = StateField.define<GitState>({
  create: () => ({ hunks: [], head: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGitChanges)) {
        return { hunks: e.value.changes?.hunks ?? [], head: e.value.head };
      }
    }
    return value;
  },
});

/** What the calha knows right now, for the keys that walk it. */
export function gitStateOf(view: EditorView): GitState {
  return view.state.field(gitHunks, false) ?? { hunks: [], head: null };
}

/** Opens the peek panel on a hunk, if there is one at that line. */
export function peekHunkAt(view: EditorView, line: number): boolean {
  const { hunks, head } = gitStateOf(view);
  const hunk = hunkAt(hunks, line);
  if (!hunk || head === null) return false;
  view.dispatch({ effects: showHunkPeek.of({ hunk, lines: peekLines(head, hunk) }) });
  return true;
}

/** The whole thing, ready to drop into the editor's extension list. */
export const gitGutterExt = [
  gitField,
  gitHunks,
  gutter({
    class: "cm-git-gutter",
    markers: (view) => view.state.field(gitField),
    domEventHandlers: {
      // The strip is four pixels wide and was, until now, unclickable
      // decoration. A press on a mark opens what that line was.
      mousedown(view, block) {
        return peekHunkAt(view, view.state.doc.lineAt(block.from).number);
      },
    },
  }),
];

// ---------------------------------------------------------------------------
// HEAD text — fetched per document, cached per disk version
// ---------------------------------------------------------------------------

/** `undefined` = never fetched; `null` = fetched, nothing to compare against. */
const headCache = new Map<string, { stamp: string; text: string | null }>();

/**
 * The file's HEAD text, cached by `stamp` (the document's disk version): a
 * save or an external reload re-asks git, typing between them does not.
 */
export async function headTextFor(
  doc: { id: string; root: string; path: string },
  stamp: string,
): Promise<string | null> {
  const hit = headCache.get(doc.id);
  if (hit && hit.stamp === stamp) return hit.text;
  let text: string | null = null;
  try {
    text = await ipc.gitHeadText(doc.root, doc.path);
  } catch {
    text = null;
  }
  headCache.set(doc.id, { stamp, text });
  return text;
}

/** Cache read for the typing debounce — no IPC on a keystroke, ever. */
export function cachedHeadText(id: string): string | null | undefined {
  return headCache.get(id)?.text;
}

/** The tab closed; its HEAD text goes with it. */
export function dropHeadText(id: string): void {
  headCache.delete(id);
}

/**
 * Everything outside `open` goes. Each entry holds a whole file as git has
 * it, so this is not bookkeeping: it is the difference between a session that
 * keeps one copy per open tab and one that keeps every file ever opened.
 */
export function keepHeadText(open: ReadonlySet<string>): void {
  for (const id of [...headCache.keys()]) {
    if (!open.has(id)) headCache.delete(id);
  }
}

/** Diffs the buffer against `head` and pushes the marks into the view. */
export function applyGitChanges(view: EditorView, head: string | null): void {
  const changes = head == null ? null : diffLines(head, view.state.doc.toString());
  view.dispatch({ effects: setGitChanges.of({ changes, head }) });
}
