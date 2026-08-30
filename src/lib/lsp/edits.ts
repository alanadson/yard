/**
 * A server's edit, turned into text.
 *
 * A quick fix, a rename or a format comes back as a `WorkspaceEdit`: ranges
 * in lines and characters, for one file or several, in whichever of the two
 * shapes the server felt like. This is the translation into offsets in a
 * string, and it is the part where a mistake does not throw, an edit applied
 * one character off silently corrupts the file the user asked to have fixed.
 *
 * Two rules carry that weight. Edits are applied **from the end of the
 * document backwards**, so an earlier one never moves a later one. And an
 * edit set whose ranges **overlap** is refused whole: there is no correct
 * order for it, and picking one writes garbage.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface TextEdit {
  range: LspRange;
  newText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The offset a `{line, character}` points at.
 *
 * A server counts lines and UTF-16 code units, never bytes, and it treats
 * `\r\n` as one break, so a CRLF file must not drift by a character per
 * line. Positions past the end of a line (or of the document) are clamped:
 * servers use `character: 999` to mean "end of line" all the time.
 */
export function offsetAt(text: string, position: LspPosition): number {
  const line = Math.max(0, position.line);
  let at = 0;
  for (let n = 0; n < line; n++) {
    const brk = text.indexOf("\n", at);
    if (brk < 0) return text.length;
    at = brk + 1;
  }
  const end = text.indexOf("\n", at);
  // The line's own end, with the CR of a CRLF break left out of it.
  let lineEnd = end < 0 ? text.length : end;
  if (lineEnd > at && text[lineEnd - 1] === "\r") lineEnd -= 1;
  return Math.min(at + Math.max(0, position.character), lineEnd);
}

export interface EditSpan {
  from: number;
  to: number;
  insert: string;
}

/**
 * The edits as offsets into `text`, in document order. `null` when the set
 * cannot be applied safely, which here means only one thing: two ranges that
 * overlap. There is no correct order for those, and picking one writes
 * garbage into a file the user asked to have fixed.
 *
 * This is the shape a live editor wants. Replacing the whole document with
 * the result of `applyTextEdits` would be wrong twice over: it makes a single
 * undo step out of what the user thinks of as "remove the unused import", and
 * it drops the caret at the top of the file.
 */
export function editSpans(text: string, edits: readonly TextEdit[]): EditSpan[] | null {
  const spans = edits.map((edit) => ({
    from: offsetAt(text, edit.range.start),
    to: offsetAt(text, edit.range.end),
    insert: edit.newText ?? "",
  }));
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from < spans[i - 1].to) return null;
  }
  return spans;
}

/**
 * `edits` applied to `text`. Returns the text unchanged when the set cannot
 * be applied safely.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return text;
  const spans = editSpans(text, edits);
  if (!spans) return text;
  let out = text;
  // Backwards: an edit near the end cannot move one nearer the start.
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    out = out.slice(0, span.from) + span.insert + out.slice(span.to);
  }
  return out;
}

/** `file:///c:/…` and `file:///C:/…` are the same file on the same disk. */
function sameUri(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function readEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is TextEdit =>
      isRecord(e) && isRecord(e.range) && isRecord(e.range.start) && isRecord(e.range.end),
  );
}

/**
 * The edits a `WorkspaceEdit` has for one document.
 *
 * Both wire shapes are read. `documentChanges` may also carry create, rename
 * and delete operations: they are skipped, because this editor does not
 * perform them, and applying only the text half of such a change would leave
 * the project in a state the server did not ask for.
 */
export function editsFor(workspaceEdit: unknown, uri: string): TextEdit[] {
  if (!isRecord(workspaceEdit)) return [];

  const changes = workspaceEdit.changes;
  if (isRecord(changes)) {
    for (const [key, value] of Object.entries(changes)) {
      if (sameUri(key, uri)) return readEdits(value);
    }
  }

  const documentChanges = workspaceEdit.documentChanges;
  if (Array.isArray(documentChanges)) {
    const out: TextEdit[] = [];
    for (const change of documentChanges) {
      if (!isRecord(change)) continue;
      const doc = change.textDocument;
      // A create/rename/delete has no `textDocument`; it has a `kind`.
      if (!isRecord(doc) || typeof doc.uri !== "string") continue;
      if (!sameUri(doc.uri, uri)) continue;
      out.push(...readEdits(change.edits));
    }
    return out;
  }

  return [];
}

/**
 * Every document a `WorkspaceEdit` touches, each once. A rename crosses files
 * by definition, and the editor has to open one before it can change it.
 */
export function urisIn(workspaceEdit: unknown): string[] {
  if (!isRecord(workspaceEdit)) return [];
  const uris = new Set<string>();
  if (isRecord(workspaceEdit.changes)) {
    for (const key of Object.keys(workspaceEdit.changes)) uris.add(key);
  }
  if (Array.isArray(workspaceEdit.documentChanges)) {
    for (const change of workspaceEdit.documentChanges) {
      if (!isRecord(change)) continue;
      const doc = change.textDocument;
      if (isRecord(doc) && typeof doc.uri === "string") uris.add(doc.uri);
    }
  }
  return [...uris];
}
