/**
 * Finding a symbol anywhere in the project.
 *
 * `Ctrl+P` already finds a *file* by name, from an index this app builds
 * itself. It cannot find `parseStoredDocs` unless you remember it lives in
 * `editorStore.ts`, and remembering which file a function is in is the exact
 * thing you are asking the editor for.
 *
 * `workspace/symbol` answers that, in two wire shapes: the old
 * `SymbolInformation` with a full location, and the newer `WorkspaceSymbol`
 * whose location may be a bare uri, because the server has not resolved the
 * range yet and would rather not pay for it until someone picks the row.
 */
import { describe, expect, it } from "vitest";

import { MAX_WORKSPACE_SYMBOLS, readWorkspaceSymbols } from "./workspaceSymbols";

const ROOT = "C:/Workspace/Code/yard";
const A = "file:///C:/Workspace/Code/yard/src/stores/editorStore.ts";

describe("readWorkspaceSymbols", () => {
  it("reads a symbol with a full location", () => {
    const reply = [
      {
        name: "parseStoredDocs",
        kind: 12,
        location: { uri: A, range: { start: { line: 245, character: 0 } } },
      },
    ];

    expect(readWorkspaceSymbols(reply, ROOT)).toEqual([
      {
        name: "parseStoredDocs",
        kind: 12,
        path: "src/stores/editorStore.ts",
        line: 246,
      },
    ]);
  });

  it("reads a symbol whose range the server has not resolved", () => {
    // The newer shape. The row still has to be offerable: landing on line 1
    // of the right file beats not offering the symbol at all.
    const reply = [{ name: "OpenDoc", kind: 11, location: { uri: A } }];

    expect(readWorkspaceSymbols(reply, ROOT)[0]).toMatchObject({
      path: "src/stores/editorStore.ts",
      line: 1,
    });
  });

  it("carries the container so two methods with one name can be told apart", () => {
    const reply = [
      {
        name: "push",
        kind: 6,
        containerName: "Fila",
        location: { uri: A, range: { start: { line: 3, character: 0 } } },
      },
    ];

    expect(readWorkspaceSymbols(reply, ROOT)[0].container).toBe("Fila");
  });

  it("says the path relative to the project", () => {
    const reply = [{ name: "x", kind: 12, location: { uri: A } }];

    expect(readWorkspaceSymbols(reply, ROOT)[0].path).toBe("src/stores/editorStore.ts");
  });

  it("keeps a symbol from outside the project under its own name", () => {
    const reply = [{ name: "x", kind: 12, location: { uri: "file:///C:/other/y.rs" } }];

    expect(readWorkspaceSymbols(reply, ROOT)[0].path).toBe("C:/other/y.rs");
  });

  it("skips a row it cannot place instead of dropping the answer", () => {
    const reply = [
      { name: "no location", kind: 12 },
      { kind: 12, location: { uri: A } },
      "nonsense",
      { name: "ok", kind: 12, location: { uri: A } },
    ];

    expect(readWorkspaceSymbols(reply, ROOT).map((r) => r.name)).toEqual(["ok"]);
  });

  it("stops at a list a person can still scan", () => {
    const many = Array.from({ length: MAX_WORKSPACE_SYMBOLS + 20 }, (_, i) => ({
      name: `s${i}`,
      kind: 12,
      location: { uri: A },
    }));

    expect(readWorkspaceSymbols(many, ROOT)).toHaveLength(MAX_WORKSPACE_SYMBOLS);
  });

  it("has nothing to show for a reply it cannot read", () => {
    expect(readWorkspaceSymbols(null, ROOT)).toEqual([]);
    expect(readWorkspaceSymbols({ symbols: [] }, ROOT)).toEqual([]);
    expect(readWorkspaceSymbols([], ROOT)).toEqual([]);
  });
});
