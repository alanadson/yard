/**
 * What the quick-fix menu offers.
 *
 * `textDocument/codeAction` answers with a mixed list: modern `CodeAction`
 * objects, bare `Command`s from older servers, actions the server has already
 * decided are unavailable, and actions whose work happens server-side through
 * `workspace/executeCommand`.
 *
 * This editor can apply an **edit**. It cannot run a server command, because
 * the reply to one arrives as a `workspace/applyEdit` *request* from the
 * server and the client in use here answers notifications, not requests. So
 * the rule is: offer what pressing Enter will actually do, and leave out what
 * would look like a fix and be a no-op. A menu entry that does nothing is
 * worse than a menu that is one entry shorter.
 */
import { describe, expect, it } from "vitest";

import { MAX_ACTIONS, readActions } from "./codeActions";

const edit = { changes: { "file:///c:/r/a.ts": [] } };

describe("readActions", () => {
  it("keeps the actions that carry an edit", () => {
    const reply = [{ title: "Import 'useState'", kind: "quickfix", edit }];

    expect(readActions(reply)).toEqual([
      { title: "Import 'useState'", kind: "quickfix", edit },
    ]);
  });

  it("leaves out an action with nothing to apply", () => {
    // A bare Command, or a CodeAction whose work is server-side.
    const reply = [
      { title: "Organize imports", command: "_typescript.organizeImports" },
      { title: "Import 'useState'", kind: "quickfix", edit },
    ];

    expect(readActions(reply).map((a) => a.title)).toEqual(["Import 'useState'"]);
  });

  it("leaves out an action the server itself marked unavailable", () => {
    const reply = [
      { title: "Cannot do this here", kind: "quickfix", edit, disabled: { reason: "no" } },
      { title: "Import 'useState'", kind: "quickfix", edit },
    ];

    expect(readActions(reply).map((a) => a.title)).toEqual(["Import 'useState'"]);
  });

  it("puts the fix the server prefers at the top", () => {
    // `isPreferred` is the server saying "this is the one", it is what a
    // single keystroke should land on.
    const reply = [
      { title: "Second", kind: "quickfix", edit },
      { title: "First", kind: "quickfix", edit, isPreferred: true },
    ];

    expect(readActions(reply).map((a) => a.title)).toEqual(["First", "Second"]);
  });

  it("puts fixes above refactors and source actions", () => {
    // Ctrl+. is pressed on a squiggle far more often than on a decision to
    // restructure something.
    const reply = [
      { title: "Extract to function", kind: "refactor.extract", edit },
      { title: "Remove unused", kind: "quickfix", edit },
      { title: "Organize", kind: "source.organizeImports", edit },
    ];

    expect(readActions(reply).map((a) => a.title)).toEqual([
      "Remove unused",
      "Extract to function",
      "Organize",
    ]);
  });

  it("keeps the server's order inside one kind", () => {
    const reply = [
      { title: "A", kind: "quickfix", edit },
      { title: "B", kind: "quickfix", edit },
      { title: "C", kind: "quickfix", edit },
    ];

    expect(readActions(reply).map((a) => a.title)).toEqual(["A", "B", "C"]);
  });

  it("stops at a menu's worth", () => {
    const many = Array.from({ length: MAX_ACTIONS + 6 }, (_, i) => ({
      title: `fix ${i}`,
      kind: "quickfix",
      edit,
    }));

    expect(readActions(many)).toHaveLength(MAX_ACTIONS);
  });

  it("has nothing to offer for a reply it cannot read", () => {
    expect(readActions(null)).toEqual([]);
    expect(readActions([])).toEqual([]);
    expect(readActions({ actions: [] })).toEqual([]);
    expect(readActions([{ edit }, "nonsense", 7])).toEqual([]);
  });
});
