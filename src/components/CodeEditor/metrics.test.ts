/**
 * The font size, the line height, the tab width and the line-number column
 * used to be numbers nailed into the CodeMirror theme (`cm.ts`): 12.5px, 1.55,
 * CodeMirror's factory `tabSize` and the numbering `basicSetup` always turns
 * on. Becoming a preference means those four values now arrive from outside —
 * and this is where their translation is pinned down, without a DOM.
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { indentString } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

import { yardSyntax } from "./cm";
import { codeMetrics, indentUnitFor, metricsSpec, type CodeMetrics } from "./metrics";

const BASE: CodeMetrics = {
  fontSize: 12.5,
  lineHeight: 1.55,
  tabSize: 2,
  hardTabs: false,
  lineNumbers: true,
};

describe("metricsSpec", () => {
  it("carries font size and line height to the text surface", () => {
    const spec = metricsSpec({ ...BASE, fontSize: 17, lineHeight: 1.9 });
    expect(spec[".cm-scroller"]).toEqual({ fontSize: "17px", lineHeight: "1.9" });
  });

  /**
   * `basicSetup` turns the numbering on and there is no way to take it out of
   * its list; whoever turns the preference off has to see the column vanish
   * regardless.
   *
   * The `!important` is not overkill: CodeMirror's base theme declares
   * `.cm-gutter { display: flex !important }` — its comment says it is there
   * to stop margins from collapsing — and a plain `display: none` loses to
   * it. Without this the field existed, saved the preference and did nothing
   * on screen; that is how this test passed green while the app showed the
   * column all the same.
   */
  it("hides the line-number column over the base theme's `!important`", () => {
    expect(metricsSpec({ ...BASE, lineNumbers: false })[".cm-lineNumbers"]).toEqual({
      display: "none !important",
    });
  });

  /**
   * And, with it on, no rule about the column may be left over: a
   * `display: block` left behind would dismantle the `<div>` the gutter uses
   * to line each number up with its row.
   */
  it("with the numbering on it leaves no column rule behind", () => {
    expect(metricsSpec(BASE)).not.toHaveProperty(".cm-lineNumbers");
  });
});

describe("codeMetrics vs. the theme", () => {
  /**
   * `yardTheme` also writes `font-size` on `.cm-scroller` — it is the floor
   * from before there was a preference, and the note editor still lives on
   * it. Two themes on the same rule: who wins is decided by **precedence**,
   * because CodeMirror mounts the style modules in reverse order of it.
   * Getting that detail wrong breaks nothing visible in the test or in `tsc`:
   * the field simply has no effect on screen.
   */
  it("the chosen size beats the theme's factory size", () => {
    const state = EditorState.create({
      extensions: [yardSyntax, codeMetrics({ ...BASE, fontSize: 20 })],
    });
    const regras = state
      .facet(EditorView.styleModule)
      .map((m) => m.getRules().replace(/\s+/g, " "));
    const daPreferencia = regras.findIndex((r) => r.includes("font-size: 20px"));
    const ofTheme = regras.findIndex((r) => r.includes("font-size: 12.5px"));
    expect(daPreferencia, "the preference's rule was not emitted").toBeGreaterThanOrEqual(0);
    expect(ofTheme, "the theme's rule was not emitted").toBeGreaterThanOrEqual(0);
    // Lower index in the facet = higher precedence = mounted last = wins.
    expect(daPreferencia).toBeLessThan(ofTheme);
  });
});

describe("indentUnitFor", () => {
  it("indents with the chosen number of spaces", () => {
    expect(indentUnitFor(4, false)).toBe("    ");
    expect(indentUnitFor(2, false)).toBe("  ");
  });

  /**
   * With real tabs, the chosen width is display only — what lands in the file
   * is a `\t`, and turning that into spaces would change the text the user
   * saves.
   */
  it("with real tabs what lands in the file is a \t", () => {
    expect(indentUnitFor(4, true)).toBe("\t");
  });
});

describe("codeMetrics", () => {
  it("the tab width reaches the editor state", () => {
    const state = EditorState.create({
      extensions: codeMetrics({ ...BASE, tabSize: 8 }),
    });
    expect(state.tabSize).toBe(8);
    expect(indentString(state, 8)).toBe(" ".repeat(8));
  });

  it("with real tabs the state's indentation is made of \t", () => {
    const state = EditorState.create({
      extensions: codeMetrics({ ...BASE, tabSize: 4, hardTabs: true }),
    });
    expect(state.tabSize).toBe(4);
    expect(indentString(state, 8)).toBe("\t\t");
  });
});
