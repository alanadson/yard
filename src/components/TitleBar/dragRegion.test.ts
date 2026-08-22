/**
 * Dragging the window by the title bar.
 *
 * The window runs undecorated (`decorations: false`): without
 * `data-tauri-drag-region` it does not budge. And the attribute has three
 * values, with quite different semantics — see `isDragRegion` in
 * `tauri/src/window/scripts/drag.js`: Tauri walks up from the click target
 * and, with the **bare** attribute, only drags if the element is the target
 * itself. A bare parent does not count for a click that landed on a child.
 *
 * The regression this test locks: the bar had the bare attribute on the
 * `<header>` and on the left-hand strips, but not on `.titlebar-right`, which
 * is `flex: 1 1 0` and therefore swallows all the empty slack of the right
 * half. Clicking there hit a `div` with no attribute, walked up to the bare
 * header, and `el === composedPath[0]` failed: the window only dragged from
 * the middle leftwards. Worse, a bare attribute on a child **cuts** the walk
 * short — the bare `.crumb` killed the drag over the project name.
 *
 * `deep` on the header fixes the whole class of defect: any empty spot on the
 * bar drags, and the real controls (`<button>`, `<input>`, an interactive
 * `role`) keep blocking the drag on their own, no markup needed.
 */
import { describe, expect, it } from "vitest";

import titleBarSrc from "./index.tsx?raw";

const ATTR = "data-tauri-drag-region";

/** The opening tag of the element with that class, JSX braces included. */
function tagOf(font: string, className: string): string {
  const pos = font.indexOf(`className="${className}"`);
  if (pos < 0) throw new Error(`não achei className="${className}" na barra`);
  const opens = font.lastIndexOf("<", pos);
  let keys = 0;
  for (let i = opens; i < font.length; i++) {
    const c = font[i];
    if (c === "{") keys++;
    else if (c === "}") keys--;
    else if (c === ">" && keys === 0) return font.slice(opens, i + 1);
  }
  throw new Error(`a tag de .${className} não fecha`);
}

/** Markup only: the prose in the comments also names the attribute. */
function withoutComments(theFont: string): string {
  return theFont.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("dragging the window by the title bar", () => {
  it("the tag comes out whole even with an arrow and braces in the middle", () => {
    const font = `<header className="x" onClick={(e) => f({ a: 1 })} ${ATTR}="deep">oi</header>`;
    expect(tagOf(font, "x")).toBe(
      `<header className="x" onClick={(e) => f({ a: 1 })} ${ATTR}="deep">`,
    );
  });

  it("the comment goes, the markup stays", () => {
    expect(withoutComments(`/* ${ATTR} */\n<i ${ATTR}="deep" />\n  // ${ATTR}\n`).trim()).toBe(
      `<i ${ATTR}="deep" />`,
    );
  });

  it("the whole bar drags: the header is `deep`, not the bare attribute", () => {
    expect(tagOf(titleBarSrc, "titlebar")).toContain(`${ATTR}="deep"`);
  });

  it("no other element repeats the attribute — bare, it becomes a dead spot", () => {
    expect(withoutComments(titleBarSrc).split(ATTR).length - 1).toBe(1);
  });
});
