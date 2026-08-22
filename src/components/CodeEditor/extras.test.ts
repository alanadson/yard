/**
 * The rainbow only exists if the grammar really hands us the bracket tokens —
 * this is the assumption the whole extension stands on, so it is pinned here
 * against the actual TypeScript grammar, headless.
 */
import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { showMinimap } from "@replit/codemirror-minimap";

import { bracketSpans, editorExtras, type ExtraFlags } from "./extras";
import { syntaxFor } from "./schemeSyntax";

function parsed(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [javascript({ typescript: true })],
  });
  // Forces the parse the editor would do in idle time.
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function levelsOf(doc: string): [string, number][] {
  const state = parsed(doc);
  return bracketSpans(state).map((s) => [doc.slice(s.from, s.to), s.level]);
}

describe("bracketSpans", () => {
  it("finds brackets in TypeScript and nests the levels", () => {
    expect(levelsOf("f(a[b{c}])")).toEqual([
      ["(", 0],
      ["[", 1],
      ["{", 2],
      ["}", 2],
      ["]", 1],
      [")", 0],
    ]);
  });

  it("ignores brackets inside strings and comments", () => {
    const doc = 'const x = "([{"; // ) closes nothing\nconst y = (1);\n';
    const spans = levelsOf(doc);
    expect(spans).toEqual([
      ["(", 0],
      [")", 0],
    ]);
  });

  it("an unbalanced file degrades to level zero instead of drifting", () => {
    const spans = levelsOf("f(a));\n");
    expect(spans.map(([, level]) => level)).toEqual([0, 0, 0]);
  });

  it("colors real-world test-file shapes (the reported case)", () => {
    const doc = 'describe("x", () => {\n  it("y", () => {\n    expect(f(["a"])).toBe(1);\n  });\n});\n';
    const spans = levelsOf(doc);
    // At minimum every bracket outside strings is present and painted.
    expect(spans.length).toBeGreaterThanOrEqual(20);
    expect(spans.some(([, level]) => level > 0)).toBe(true);
  });
});

/**
 * The minimap is vendored (`@replit/codemirror-minimap`) and it re-highlights
 * the document on exactly four signals: the text changed, the folds changed,
 * the editor's theme classes changed — or **its own config object changed
 * identity**. A grammar that arrives late is none of the first three: this
 * editor opens the file with an empty language compartment and reconfigures it
 * when the `import()` of the grammar resolves, so the map was built while the
 * document was still plain text and stayed grey forever.
 *
 * Hence these tests assert on the identity of the config the extension hands
 * the minimap: it is the only lever we have to say "paint it again".
 */
describe("minimap", () => {
  const FLAGS: ExtraFlags = {
    rainbow: false,
    todos: false,
    minimap: true,
    indent: false,
    cssColors: false,
  };

  const config = (state: EditorState) => state.facet(showMinimap);

  it("asks for a repaint when the grammar arrives after the file is open", () => {
    const lang = new Compartment();
    const state = EditorState.create({
      doc: "const x = 1;\n",
      extensions: [editorExtras(FLAGS), lang.of([])],
    });
    const after = state.update({
      effects: lang.reconfigure(javascript({ typescript: true })),
    }).state;
    expect(config(after)).not.toBe(config(state));
  });

  it("asks for a repaint when the color scheme swaps the highlight style", () => {
    const syntax = new Compartment();
    const state = EditorState.create({
      doc: "const x = 1;\n",
      extensions: [
        editorExtras(FLAGS),
        javascript({ typescript: true }),
        syntax.of(syntaxFor(null)),
      ],
    });
    const after = state.update({
      effects: syntax.reconfigure(syntaxFor("theme-dracula")),
    }).state;
    expect(config(after)).not.toBe(config(state));
  });

  it("does not ask for a repaint on every keystroke — the minimap handles text itself", () => {
    const state = EditorState.create({
      doc: "const x = 1;\n",
      extensions: [editorExtras(FLAGS), javascript({ typescript: true })],
    });
    const after = state.update({ changes: { from: 0, insert: "//\n" } }).state;
    expect(config(after)).toBe(config(state));
  });
});
