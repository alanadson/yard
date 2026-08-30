/**
 * Every problem in the project, not just the ones in the file on screen.
 *
 * Diagnostics already reached the editor, but only as squiggles inside an
 * open document, which means the answer to "is this branch clean?" was
 * "open all forty files and look". Servers do not work that way: they
 * `publishDiagnostics` for whatever they have compiled, open or not, and that
 * feed was being thrown away.
 *
 * Two things make this delicate. The feed is **authoritative per file**: a
 * notification carrying an empty list means "this file is clean now", and
 * treating it as "nothing to add" leaves a fixed error on screen forever.
 * And it is a feed from a foreign process, so every field is read rather than
 * assumed.
 */
import { describe, expect, it } from "vitest";

import {
  countBySeverity,
  dropRoot,
  NO_PROBLEMS,
  diagnosticsAt,
  problemGroups,
  problemRows,
  receive,
} from "./problems";

const ROOT = "C:/Workspace/Code/yard";
const A = "file:///C:/Workspace/Code/yard/src/a.ts";
const B = "file:///C:/Workspace/Code/yard/src/b.ts";

const diag = (line: number, severity: number, message: string) => ({
  range: { start: { line, character: 4 }, end: { line, character: 9 } },
  severity,
  message,
  source: "ts",
});

describe("receive", () => {
  it("keeps what a file reported", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [diag(3, 1, "boom")]);

    expect(problemRows(state)).toHaveLength(1);
  });

  it("replaces a file's list rather than adding to it", () => {
    // The second notification is the whole truth about that file.
    let state = receive(NO_PROBLEMS, ROOT, A, [diag(3, 1, "boom"), diag(9, 2, "meh")]);
    state = receive(state, ROOT, A, [diag(3, 1, "boom")]);

    expect(problemRows(state)).toHaveLength(1);
  });

  it("clears a file when the server says it is clean", () => {
    // The regression this locks: treating an empty list as "nothing to do"
    // leaves a fixed error on the panel until the app restarts.
    let state = receive(NO_PROBLEMS, ROOT, A, [diag(3, 1, "boom")]);
    state = receive(state, ROOT, A, []);

    expect(problemRows(state)).toEqual([]);
  });

  it("says the path relative to the project, not the uri", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [diag(3, 1, "boom")]);

    expect(problemRows(state)[0].path).toBe("src/a.ts");
  });

  it("matches the root however the server spelled the drive letter", () => {
    const state = receive(NO_PROBLEMS, "c:/workspace/code/yard", A, [diag(3, 1, "boom")]);

    expect(problemRows(state)[0].path).toBe("src/a.ts");
  });

  it("keeps a file outside the project under its own name", () => {
    // `rust-analyzer` reports on the crates in the registry all the time.
    const state = receive(NO_PROBLEMS, ROOT, "file:///C:/other/x.rs", [diag(1, 1, "boom")]);

    expect(problemRows(state)[0].path).toBe("C:/other/x.rs");
  });

  it("skips a diagnostic with no place in the file", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [
      { message: "no range" },
      diag(3, 1, "boom"),
      "nonsense",
    ]);

    expect(problemRows(state)).toHaveLength(1);
  });

  it("treats a diagnostic with no severity as an error", () => {
    // The protocol allows it, and the safe reading of "something is wrong
    // and I did not say how badly" is not "hint".
    const state = receive(NO_PROBLEMS, ROOT, A, [
      { range: diag(3, 1, "x").range, message: "unsaid" },
    ]);

    expect(problemRows(state)[0].severity).toBe(1);
  });
});

describe("problemRows", () => {
  it("puts errors above warnings, then reads top to bottom", () => {
    let state = receive(NO_PROBLEMS, ROOT, B, [diag(1, 2, "warn b"), diag(2, 1, "err b")]);
    state = receive(state, ROOT, A, [diag(5, 1, "err a"), diag(1, 3, "info a")]);

    expect(problemRows(state).map((r) => r.message)).toEqual([
      "err a",
      "err b",
      "warn b",
      "info a",
    ]);
  });

  it("gives a row the 1-based line and column a person reads", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [diag(3, 1, "boom")]);

    expect(problemRows(state)[0]).toMatchObject({ line: 4, column: 5 });
  });
});

describe("countBySeverity and dropRoot", () => {
  it("counts what the status of a project is in two numbers", () => {
    let state = receive(NO_PROBLEMS, ROOT, A, [diag(1, 1, "a"), diag(2, 2, "b")]);
    state = receive(state, ROOT, B, [diag(1, 1, "c"), diag(2, 4, "d")]);

    expect(countBySeverity(state)).toEqual({ errors: 2, warnings: 1, other: 1 });
  });

  it("forgets a project whose servers are gone", () => {
    // Otherwise closing a project leaves its errors on the panel of the next.
    let state = receive(NO_PROBLEMS, ROOT, A, [diag(1, 1, "a")]);
    state = receive(state, "C:/other", "file:///C:/other/x.rs", [diag(1, 1, "b")]);

    expect(problemRows(dropRoot(state, ROOT)).map((r) => r.message)).toEqual(["b"]);
  });
});


/**
 * The panel's own shape: one section per file. Grouping and ranking are
 * separate questions from `problemRows`, inside a file the reader wants to
 * walk *down* it, and between files they want the broken one first.
 */
describe("problemGroups", () => {
  it("gives one section per file, read top to bottom inside it", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [diag(9, 2, "late"), diag(2, 1, "early")]);

    const groups = problemGroups(state);

    expect(groups).toHaveLength(1);
    expect(groups[0].path).toBe("src/a.ts");
    expect(groups[0].rows.map((r) => r.message)).toEqual(["early", "late"]);
  });

  it("puts the file with the worst problem first", () => {
    let state = receive(NO_PROBLEMS, ROOT, B, [diag(1, 2, "just a warning")]);
    state = receive(state, ROOT, A, [diag(1, 1, "an error")]);

    expect(problemGroups(state).map((g) => g.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("breaks a tie by path, so the list does not shuffle as it updates", () => {
    let state = receive(NO_PROBLEMS, ROOT, B, [diag(1, 1, "b")]);
    state = receive(state, ROOT, A, [diag(1, 1, "a")]);

    expect(problemGroups(state).map((g) => g.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("can be narrowed to what is actually broken", () => {
    // A project with four hundred lint hints and one type error: the error is
    // the reason anyone opened the panel.
    let state = receive(NO_PROBLEMS, ROOT, A, [diag(1, 1, "err")]);
    state = receive(state, ROOT, B, [diag(1, 3, "hint")]);

    const groups = problemGroups(state, true);

    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((r) => r.message)).toEqual(["err"]);
  });

  it("counts what each file carries", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [diag(1, 1, "a"), diag(2, 2, "b")]);

    expect(problemGroups(state)[0].rows).toHaveLength(2);
    expect(problemGroups(state)[0].worst).toBe(1);
  });
});


/**
 * The raw diagnostics, kept alongside the rows the panel draws.
 *
 * A quick fix is not computed from a position: `textDocument/codeAction`
 * takes the *diagnostics* the client is asking about, and `tsserver` in
 * particular answers nothing useful without them, it looks up its fixes by
 * the error code we hand back. The normalised `Problem` has thrown that code
 * away, so the untouched entry is kept too.
 */
describe("diagnosticsAt", () => {
  it("hands back the entry covering the line, exactly as it arrived", () => {
    const original = { ...diag(3, 1, "boom"), code: 2304, data: { fixId: 7 } };
    const state = receive(NO_PROBLEMS, ROOT, A, [original]);

    expect(diagnosticsAt(state, A, 3)).toEqual([original]);
  });

  it("ignores the entries on other lines", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [diag(3, 1, "here"), diag(9, 1, "elsewhere")]);

    expect(diagnosticsAt(state, A, 3)).toHaveLength(1);
  });

  it("counts a diagnostic that spans several lines", () => {
    const wide = {
      range: { start: { line: 2, character: 0 }, end: { line: 8, character: 0 } },
      severity: 1,
      message: "block",
    };
    const state = receive(NO_PROBLEMS, ROOT, A, [wide]);

    expect(diagnosticsAt(state, A, 5)).toHaveLength(1);
  });

  it("has nothing for a file nobody reported on", () => {
    expect(diagnosticsAt(NO_PROBLEMS, A, 3)).toEqual([]);
  });

  it("matches the uri however the drive letter was spelled", () => {
    const state = receive(NO_PROBLEMS, ROOT, A, [diag(3, 1, "boom")]);

    expect(diagnosticsAt(state, A.replace("/C:/", "/c:/"), 3)).toHaveLength(1);
  });
});
