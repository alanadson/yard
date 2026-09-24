/**
 * What one tree row draws, reduced to plain values.
 *
 * The tree re-renders every time `git status` comes back changed, and while
 * an agent is working that is every 1.2 s. The rows are memoized, so each one
 * receives only what it draws (its own git letter, its own dot) instead of the
 * project-wide map. If this projection drifts from what the row used to work
 * out for itself, a file silently loses its color or a folder its dot.
 *
 * The second half is `content-visibility: auto` on the rows. Skipping an
 * off-screen row is only free when everything the row paints fits inside its
 * own box, and when the placeholder it leaves behind is the row's real height;
 * otherwise the tree loses a focus halo, clips an icon or makes the scrollbar
 * jump.
 */
import { describe, expect, it } from "vitest";

import editorCss from "../CodeEditor/editor.css?raw";
import {
  OFFSCREEN_DEPTH_MAX,
  OFFSCREEN_SKIP,
  gitMarks,
  rowMark,
  skipsOffscreen,
} from "./rowView";

const MARKS = gitMarks([
  { path: "src/App.tsx", status: "modified" },
  { path: "src/stores/a.ts", status: "untracked" },
  { path: "docs/guide/x.md", status: "renamed" },
  { path: "lib", status: "added" },
  { path: "lib/inner.ts", status: "modified" },
]);

describe("rowMark", () => {
  it("a changed file shows its own git state, with no dot", () => {
    expect(rowMark(MARKS, "src/App.tsx", false)).toEqual({ status: "modified", dot: false });
    expect(rowMark(MARKS, "src/stores/a.ts", false)).toEqual({ status: "untracked", dot: false });
  });

  it("a clean file shows nothing", () => {
    expect(rowMark(MARKS, "src/main.tsx", false)).toEqual({ status: null, dot: false });
  });

  it("a folder with a change anywhere below it gets the dot, at every level up", () => {
    expect(rowMark(MARKS, "docs", true)).toEqual({ status: null, dot: true });
    expect(rowMark(MARKS, "docs/guide", true)).toEqual({ status: null, dot: true });
    expect(rowMark(MARKS, "src/stores", true)).toEqual({ status: null, dot: true });
    // A sibling folder with nothing changed inside stays clean.
    expect(rowMark(MARKS, "docs/api", true)).toEqual({ status: null, dot: false });
  });

  it("a folder with a state of its own shows the state, not the dot", () => {
    expect(rowMark(MARKS, "lib", true)).toEqual({ status: "added", dot: false });
  });

  it("only folders carry the dot: a file at a changed path's parent stays clean", () => {
    // The listing can be a beat behind git (a file that became a folder).
    expect(rowMark(MARKS, "docs", false)).toEqual({ status: null, dot: false });
  });

  it("with no git summary, nothing is marked", () => {
    const none = gitMarks(undefined);
    expect(rowMark(none, "src/App.tsx", false)).toEqual({ status: null, dot: false });
    expect(rowMark(none, "src", true)).toEqual({ status: null, dot: false });
  });
});

describe("skipsOffscreen", () => {
  it("a row of an ordinary tree may skip layout and paint while off-screen", () => {
    expect(skipsOffscreen(0, false)).toBe(true);
    expect(skipsOffscreen(OFFSCREEN_DEPTH_MAX, false)).toBe(true);
  });

  it("no row is skipped while a name is being typed: the field's focus halo reaches past its own row", () => {
    expect(skipsOffscreen(0, true)).toBe(false);
    expect(skipsOffscreen(3, true)).toBe(false);
  });

  it("a row indented past the cap keeps painting: its fixed icons can outgrow the narrowest host", () => {
    expect(skipsOffscreen(OFFSCREEN_DEPTH_MAX + 1, false)).toBe(false);
  });

  it("the placeholder a skipped row reserves is the row's real height", () => {
    const rule = /\.ftree-row \{([^}]*)\}/.exec(editorCss);
    expect(rule, "the .ftree-row rule is gone from editor.css").not.toBeNull();
    const height = /(?:^|;|\s)height:\s*(\d+)px/.exec(rule![1]);
    expect(height, ".ftree-row no longer declares a px height").not.toBeNull();

    expect(OFFSCREEN_SKIP.contentVisibility).toBe("auto");
    // `auto` keeps the size the row last rendered at; the length is what a
    // row that was never on screen reserves.
    expect(OFFSCREEN_SKIP.containIntrinsicSize).toBe(`auto ${height![1]}px`);
  });
});
