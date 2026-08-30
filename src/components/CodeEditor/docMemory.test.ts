/**
 * What the editor keeps about a file it is not showing.
 *
 * One CodeMirror view serves every tab, so switching files is a `setState`.
 * The state carries the caret, the selection, the undo history and the folds,
 * and it used to carry *only* those: the scroll position does not live in an
 * `EditorState`, so coming back to a file dropped the reader at the top of a
 * three thousand line file they had been reading in the middle.
 *
 * The pair is the whole point of this module. A snapshot belongs to the state
 * it was taken from, and replaying one over the wrong document scrolls to a
 * position that means nothing there.
 */
import { describe, expect, it } from "vitest";

import { DocMemory } from "./docMemory";

describe("DocMemory", () => {
  it("gives the scroll back together with the state", () => {
    const memory = new DocMemory<string, string>(4);
    memory.remember("a", "state-a", "scroll-a");

    expect(memory.recall("a")).toEqual({ state: "state-a", scroll: "scroll-a" });
  });

  it("has nothing for a file it was never told about", () => {
    // The regression this locks: a caller that reached for "the last
    // snapshot" instead of "this document's snapshot" would scroll a freshly
    // opened file to wherever the previous one happened to be.
    const memory = new DocMemory<string, string>(4);
    memory.remember("a", "state-a", "scroll-a");

    expect(memory.recall("b")).toBeUndefined();
  });

  it("keeps a state that has no scroll yet", () => {
    // A file opened and never scrolled still has to remember its caret.
    const memory = new DocMemory<string, string>(4);
    memory.remember("a", "state-a", null);

    expect(memory.recall("a")).toEqual({ state: "state-a", scroll: null });
  });

  it("replaces the pair when the same file is remembered again", () => {
    const memory = new DocMemory<string, string>(4);
    memory.remember("a", "state-a", "scroll-top");
    memory.remember("a", "state-a2", "scroll-bottom");

    expect(memory.recall("a")).toEqual({ state: "state-a2", scroll: "scroll-bottom" });
    expect(memory.size).toBe(1);
  });

  it("forgets every file that is no longer open", () => {
    // The leak this locks down: an `EditorState` holds the whole document and
    // its undo history. Closing forty tabs used to leave forty of them alive
    // for the rest of the session.
    const memory = new DocMemory<string, string>(8);
    memory.remember("a", "state-a", null);
    memory.remember("b", "state-b", null);
    memory.remember("c", "state-c", null);

    memory.keep(["a", "c"]);

    expect(memory.recall("b")).toBeUndefined();
    expect(memory.recall("a")).toBeDefined();
    expect(memory.recall("c")).toBeDefined();
  });

  it("drops the file the reader has gone longest without touching", () => {
    const memory = new DocMemory<string, string>(2);
    memory.remember("a", "state-a", null);
    memory.remember("b", "state-b", null);
    memory.recall("a"); // reading promotes it
    memory.remember("c", "state-c", null);

    expect(memory.recall("b")).toBeUndefined();
    expect(memory.recall("a")).toBeDefined();
    expect(memory.recall("c")).toBeDefined();
  });
});
