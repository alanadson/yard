/**
 * What the terminal view needs from the components that host it.
 *
 * First, when a revealed terminal resumes its renderer, and who may ask for
 * it. A tab pane hides its inactive terminals out of the viewport, and xterm
 * stops painting them there; its observer only reports the way back after
 * the reveal frame is painted (`lib/xtermResume.ts`). So the resume has to run
 * where React has already put the tab on screen but the browser has not
 * painted it yet: a layout effect. A passive effect is allowed to run after
 * that paint, and the stale frame would be back.
 *
 * And it is opt-in. A canvas card's `visible` is true for cards up to a screen
 * away from the board's edge, which are off screen on purpose and must stay
 * paused by xterm's own observer: resuming them would repaint every card near
 * the edge for nothing.
 *
 * Then, props that stay put. The view is memoized so that a host re-rendering
 * for its own reasons (a card dragged across the board, the active tab's
 * memory ticking in the pane) leaves the terminal alone, and an arrow written
 * inline in the host's JSX is a new prop on every render: the memo never
 * holds, and the terminal re-renders with its host anyway.
 */
import { describe, expect, it } from "vitest";

import viewSrc from "./index.tsx?raw";
import cardSrc from "../CanvasView/TerminalCard.tsx?raw";
import paneSrc from "../TerminalPane/index.tsx?raw";

/** The callback and dependency list of every `hook(() => { ... }, [...])` call in a source. */
function hookCalls(source: string, hook: string): { body: string; deps: string }[] {
  const out: { body: string; deps: string }[] = [];
  for (const m of source.matchAll(new RegExp(`\\b${hook}\\(\\(\\) => \\{`, "g"))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
    }
    const body = source.slice(m.index + m[0].length, i - 1);
    const deps = /^\s*,\s*(\[[^\]]*\])/.exec(source.slice(i))?.[1] ?? "";
    out.push({ body, deps });
  }
  return out;
}

describe("hookCalls", () => {
  it("reads the whole callback and its dependency list", () => {
    const src = "useLayoutEffect(() => {\n  if (a) { go(); }\n}, [id, a]);";
    expect(hookCalls(src, "useLayoutEffect")).toEqual([
      { body: "\n  if (a) { go(); }\n", deps: "[id, a]" },
    ]);
  });
});

describe("the terminal view", () => {
  it("resumes a revealed terminal in a layout effect, before the reveal frame is painted", () => {
    const resumes = hookCalls(viewSrc, "useLayoutEffect").filter((h) =>
      h.body.includes("resumeRenderer(termRef.current)"),
    );
    expect(resumes).toHaveLength(1);
    expect(resumes[0].body).toContain("visible && resumeOnShow");
    expect(resumes[0].deps).toContain("visible");
  });

  it("never resumes from a passive effect, which may run after that paint", () => {
    const late = hookCalls(viewSrc, "useEffect").filter((h) => h.body.includes("resumeRenderer("));
    expect(late).toEqual([]);
  });
});

/** The `<XTermView ... />` element of a source, brace-balanced. */
function viewElement(source: string): string {
  const start = source.indexOf("<XTermView");
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") depth -= 1;
    else if (depth === 0 && source.startsWith("/>", i)) return source.slice(start, i + 2);
  }
  return "";
}

/** Props whose value is an arrow written right there: a new function per render. */
function inlineArrows(element: string): string[] {
  return [...element.matchAll(/(\w+)=\{\s*(?:async\s*)?(?:\([^()]*\)|\w+)\s*=>/g)].map((m) => m[1]);
}

describe("viewElement and inlineArrows", () => {
  it("find the arrows in an element whose props hold braces and arrows of their own", () => {
    const src = [
      "<A>",
      "<XTermView",
      "  ref={setRef}",
      "  size={n > 1 ? { a: 1 } : undefined}",
      "  onFocus={() => go(id)}",
      "  onMenu={(e) => open(e.x)}",
      "/>",
      "</A>",
    ].join("\n");
    const element = viewElement(src);
    expect(element.startsWith("<XTermView")).toBe(true);
    expect(element.endsWith("onMenu={(e) => open(e.x)}\n/>")).toBe(true);
    expect(inlineArrows(element)).toEqual(["onFocus", "onMenu"]);
  });
});

describe("the tab pane", () => {
  it("hands its terminals no function made during render, so its own re-renders skip them", () => {
    const element = viewElement(paneSrc);
    expect(element).toContain("id={t.id}");
    expect(inlineArrows(element)).toEqual([]);
  });
});

describe("the canvas card", () => {
  it("does not opt in: its off-screen margin stays paused by xterm's own observer", () => {
    expect(cardSrc).not.toContain("resumeOnShow");
  });

  it("hands the terminal no function made during render, so a drag frame does not re-render it", () => {
    const element = viewElement(cardSrc);
    expect(element).toContain("id={term.id}");
    expect(inlineArrows(element)).toEqual([]);
  });
});
