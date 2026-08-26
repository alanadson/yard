/**
 * CodeMirror's own panels (Ctrl+F, Ctrl+G, completions) ship English labels
 * and the app translates them through `EditorState.phrases`. That table used
 * to be a fixed Portuguese map: with the interface in English the find bar
 * still said "Buscar". The phrases read the active language when the panel
 * is built, so the same state serves both — no rebuild, no second bundle.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { setActiveLang } from "../../lib/i18n";
import { yardSyntax } from "./cm";

afterEach(() => setActiveLang("pt-BR"));

describe("editor phrases", () => {
  it("speak Portuguese when the interface does", () => {
    setActiveLang("pt-BR");
    const state = EditorState.create({ doc: "", extensions: [yardSyntax] });
    expect(state.phrase("Find")).toBe("Buscar");
    expect(state.phrase("replaced $ matches")).toBe("$ ocorrências substituídas");
  });

  it("leave CodeMirror's English alone when the interface is English", () => {
    setActiveLang("en");
    const state = EditorState.create({ doc: "", extensions: [yardSyntax] });
    expect(state.phrase("Find")).toBe("Find");
    expect(state.phrase("Go to line")).toBe("Go to line");
  });
});
