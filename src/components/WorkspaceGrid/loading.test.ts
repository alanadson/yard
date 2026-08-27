/**
 * Waiting is not the same news as having nothing.
 *
 * The canvas is a lazy chunk, and its `Suspense` fallback was
 * `<div className="grid-empty" />` — the very class the "no terminals in this
 * group" screen uses, with no children. So the first time anyone opened the
 * board in a session, a heavy chunk loaded behind a blank grey rectangle that
 * looks exactly like an empty group, or like a crash. Two different states
 * cannot share one appearance, least of all when one of them is "it is
 * working, wait".
 *
 * The style guard in `src/styles.test.ts` already covers the other half of
 * this: whatever class the fallback uses has to be in the boot sheet, because
 * it is on screen precisely while the chunk it belongs to has not arrived.
 */
import { describe, expect, it } from "vitest";

import gridSrc from "./index.tsx?raw";

/** The `fallback={…}` expressions in a source, brace-balanced. */
function fallbacks(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/fallback=\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
    }
    out.push(source.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

describe("the canvas chunk's waiting screen", () => {
  it("reads the expression and not the word", () => {
    expect(fallbacks("<Suspense fallback={<A x={1} />}>")).toEqual(["<A x={1} />"]);
  });

  it("exists at all", () => {
    expect(fallbacks(gridSrc).length).toBeGreaterThan(0);
  });

  it("never wears the empty group's clothes", () => {
    const guilty = fallbacks(gridSrc).filter((f) => f.includes("grid-empty"));
    expect(guilty, "the loading state is drawn as the empty state").toEqual([]);
  });

  it("says out loud that it is loading, for whoever cannot see the skeleton", () => {
    const all = fallbacks(gridSrc).join("\n");
    expect(all).toContain('role="status"');
    expect(all).toContain("aria-label");
  });
});
