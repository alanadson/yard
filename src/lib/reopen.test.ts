/**
 * Why these rules matter: Ctrl+W is one key away from Ctrl+E, and the tab it
 * closes may be a file three folders deep that took a quick-open and two
 * guesses to find. The undo for that is this stack.
 *
 * The rules worth locking down are the ones that decide whether the stack is
 * *useful* rather than merely present: what is worth remembering (an unsaved
 * draft is never closed silently, so it never gets here), what happens when
 * the same tab is closed twice, and the ceiling that keeps a session's worth
 * of closings from becoming a memory leak.
 */
import { describe, expect, it } from "vitest";

import { REOPEN_CAP, pushClosed, popClosed, type ClosedTab } from "./reopen";

const doc = (path: string): ClosedTab => ({
  kind: "doc",
  key: `D:\repo|${path}`,
  root: "D:\repo",
  path,
  groupId: "g1",
  slot: 0,
  closedAt: 1,
});

const browser = (url: string): ClosedTab => ({
  kind: "browser",
  key: `b|${url}`,
  url,
  groupId: "g1",
  slot: 0,
  closedAt: 1,
});

describe("pushClosed", () => {
  it("puts the newest on top — the last thing closed is what Ctrl+Shift+T reopens", () => {
    const stack = pushClosed(pushClosed([], doc("a.ts")), doc("b.ts"));
    expect(popClosed(stack).tab?.key).toContain("b.ts");
  });

  /**
   * The regression: closing, reopening and closing the same file again left
   * two entries, so the second Ctrl+Shift+T reopened a tab that was already
   * on screen and nothing appeared to happen.
   */
  it("keeps one entry per tab — the newest closing wins", () => {
    const stack = pushClosed(pushClosed(pushClosed([], doc("a.ts")), doc("b.ts")), doc("a.ts"));
    expect(stack).toHaveLength(2);
    expect(popClosed(stack).tab?.key).toContain("a.ts");
  });

  it("drops the oldest past the cap", () => {
    let stack: ClosedTab[] = [];
    for (let i = 0; i < REOPEN_CAP + 5; i++) stack = pushClosed(stack, doc(`f${i}.ts`));
    expect(stack).toHaveLength(REOPEN_CAP);
    expect(stack.some((t) => t.key.includes("f0.ts"))).toBe(false);
  });

  it("remembers browser tabs too — they are tabs in the same bar", () => {
    const stack = pushClosed([], browser("https://exemplo.dev"));
    expect(popClosed(stack).tab?.kind).toBe("browser");
  });
});

describe("popClosed", () => {
  it("hands over the top and the stack without it", () => {
    const stack = pushClosed(pushClosed([], doc("a.ts")), doc("b.ts"));
    const { tab, rest } = popClosed(stack);
    expect(tab?.key).toContain("b.ts");
    expect(rest).toHaveLength(1);
  });

  it("answers with nothing on an empty stack instead of throwing", () => {
    expect(popClosed([]).tab).toBeNull();
    expect(popClosed([]).rest).toEqual([]);
  });
});
