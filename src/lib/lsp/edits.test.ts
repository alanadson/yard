/**
 * Turning a server's edit into text.
 *
 * A quick fix arrives as a `WorkspaceEdit`: positions in lines and
 * characters, for one file or several, in whichever of the two shapes the
 * server prefers. Everything here is the translation into an offset in a
 * string, and the translation is where the damage would be, an edit applied
 * one character off does not fail, it silently corrupts the file the user
 * asked to have fixed.
 *
 * Hence the two rules the tests below are really about: apply from the end of
 * the document backwards, so earlier edits never move later ones; and refuse
 * an edit set that overlaps, because there is no correct way to apply it and
 * guessing writes garbage.
 */
import { describe, expect, it } from "vitest";

import { applyTextEdits, editSpans, editsFor, offsetAt, urisIn } from "./edits";

const text = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");

describe("offsetAt", () => {
  it("counts from the start of the document", () => {
    expect(offsetAt(text, { line: 0, character: 0 })).toBe(0);
    expect(offsetAt(text, { line: 0, character: 6 })).toBe(6);
  });

  it("counts the line break as one character", () => {
    expect(offsetAt(text, { line: 1, character: 0 })).toBe(13);
  });

  it("counts a CRLF break as one position too", () => {
    // The buffer keeps whatever the file had; a server counts *lines*, not
    // bytes, so a CRLF file must not drift by one character per line.
    const crlf = ["a", "b", "c"].join("\r\n");
    expect(offsetAt(crlf, { line: 2, character: 0 })).toBe(6);
  });

  it("clamps a character past the end of its line", () => {
    // Servers do this routinely to mean "end of line".
    expect(offsetAt(text, { line: 0, character: 999 })).toBe(12);
  });

  it("clamps a line past the end of the document", () => {
    expect(offsetAt(text, { line: 99, character: 0 })).toBe(text.length);
  });
});

describe("applyTextEdits", () => {
  it("replaces a range", () => {
    const edits = [
      { range: at(0, 6, 0, 7), newText: "primeiro" },
    ];

    expect(applyTextEdits(text, edits)).toContain("const primeiro = 1;");
  });

  it("applies several edits without letting the earlier ones move the later", () => {
    // The regression this locks: applying front to back shifts every
    // remaining range by the length the first edit changed.
    const edits = [
      { range: at(0, 6, 0, 7), newText: "primeiro" },
      { range: at(2, 6, 2, 7), newText: "terceiro" },
    ];

    const out = applyTextEdits(text, edits);

    expect(out).toContain("const primeiro = 1;");
    expect(out).toContain("const terceiro = 3;");
    expect(out).toContain("const b = 2;");
  });

  it("inserts where the range is empty", () => {
    expect(applyTextEdits(text, [{ range: at(0, 0, 0, 0), newText: "// topo\n" }])).toBe(
      "// topo\n" + text,
    );
  });

  it("deletes where the new text is empty", () => {
    expect(applyTextEdits(text, [{ range: at(1, 0, 2, 0) }])).toBe(
      "const a = 1;\nconst c = 3;",
    );
  });

  it("refuses an edit set whose ranges overlap", () => {
    // There is no right answer here, and half-applying one writes garbage
    // into a file the user asked to have *fixed*.
    const edits = [
      { range: at(0, 0, 0, 8), newText: "x" },
      { range: at(0, 4, 0, 10), newText: "y" },
    ];

    expect(applyTextEdits(text, edits)).toBe(text);
  });

  it("changes nothing when there is nothing to do", () => {
    expect(applyTextEdits(text, [])).toBe(text);
  });
});

describe("editsFor", () => {
  const uri = "file:///c:/r/a.ts";

  it("reads the plain `changes` map", () => {
    const edit = { changes: { [uri]: [{ range: at(0, 0, 0, 1), newText: "X" }] } };

    expect(editsFor(edit, uri)).toHaveLength(1);
  });

  it("reads the versioned `documentChanges` list", () => {
    const edit = {
      documentChanges: [
        {
          textDocument: { uri, version: 3 },
          edits: [{ range: at(0, 0, 0, 1), newText: "X" }],
        },
      ],
    };

    expect(editsFor(edit, uri)).toHaveLength(1);
  });

  it("ignores the edits meant for other files", () => {
    const edit = {
      changes: {
        [uri]: [{ range: at(0, 0, 0, 1), newText: "X" }],
        "file:///c:/r/b.ts": [{ range: at(0, 0, 0, 1), newText: "Y" }],
      },
    };

    expect(editsFor(edit, uri)).toEqual([
      { range: at(0, 0, 0, 1), newText: "X" },
    ]);
  });

  it("matches the uri however the server spelled the drive letter", () => {
    // One server answers `file:///c:/…`, another `file:///C:/…`, and they
    // mean the same file on the same disk.
    const edit = { changes: { "file:///C:/r/a.ts": [{ range: at(0, 0, 0, 1), newText: "X" }] } };

    expect(editsFor(edit, uri)).toHaveLength(1);
  });

  it("skips a `documentChanges` entry that creates or renames a file", () => {
    // Those are real operations in the protocol and this editor does not do
    // them. Applying only the text part of such a change would be worse than
    // applying none of it.
    const edit = {
      documentChanges: [
        { kind: "create", uri: "file:///c:/r/new.ts" },
        { textDocument: { uri, version: 1 }, edits: [{ range: at(0, 0, 0, 1), newText: "X" }] },
      ],
    };

    expect(editsFor(edit, uri)).toHaveLength(1);
  });

  it("has nothing to hand over for a reply it cannot read", () => {
    expect(editsFor(null, uri)).toEqual([]);
    expect(editsFor({}, uri)).toEqual([]);
    expect(editsFor({ changes: "nope" }, uri)).toEqual([]);
  });
});

function at(l1: number, c1: number, l2: number, c2: number) {
  return { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } };
}


/**
 * The same edits as offsets, for a live editor.
 *
 * Replacing the whole document with the result of `applyTextEdits` would
 * work and would be wrong twice over: it makes one undo step out of what the
 * user thinks of as "remove the unused import", and it moves the caret to the
 * top of the file. Spans keep both.
 */
describe("editSpans", () => {
  it("gives one span per edit, in document order", () => {
    const spans = editSpans(text, [
      { range: at(2, 6, 2, 7), newText: "terceiro" },
      { range: at(0, 6, 0, 7), newText: "primeiro" },
    ]);

    expect(spans).toEqual([
      { from: 6, to: 7, insert: "primeiro" },
      { from: 32, to: 33, insert: "terceiro" },
    ]);
  });

  it("says nothing can be done when the ranges overlap", () => {
    const spans = editSpans(text, [
      { range: at(0, 0, 0, 8), newText: "x" },
      { range: at(0, 4, 0, 10), newText: "y" },
    ]);

    expect(spans).toBeNull();
  });

  it("has no spans for no edits", () => {
    expect(editSpans(text, [])).toEqual([]);
  });
});


/**
 * Which files an edit touches. A rename crosses files by definition, and so
 * does "add the missing import" when the import has to be re-exported, the
 * editor has to know to open them before it can change them.
 */
describe("urisIn", () => {
  it("lists the files of a `changes` map", () => {
    const edit = {
      changes: {
        "file:///c:/r/a.ts": [],
        "file:///c:/r/b.ts": [],
      },
    };

    expect(urisIn(edit).sort()).toEqual(["file:///c:/r/a.ts", "file:///c:/r/b.ts"]);
  });

  it("lists the files of a `documentChanges` list, once each", () => {
    const edit = {
      documentChanges: [
        { textDocument: { uri: "file:///c:/r/a.ts" }, edits: [] },
        { textDocument: { uri: "file:///c:/r/a.ts" }, edits: [] },
        { kind: "rename", oldUri: "x", newUri: "y" },
      ],
    };

    expect(urisIn(edit)).toEqual(["file:///c:/r/a.ts"]);
  });

  it("has nothing to list for a reply it cannot read", () => {
    expect(urisIn(null)).toEqual([]);
    expect(urisIn({})).toEqual([]);
  });
});
