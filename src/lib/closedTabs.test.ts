/**
 * Ctrl+Shift+T: the tab you did not mean to close.
 *
 * The editor already keeps drafts across a reload, so the cost of closing a
 * tab by accident was never the text, it was the *place*: which pane it was
 * in, which comparison it was showing, where in the tree you had found it.
 * That is what this stack holds, and it is why the entry is a description of
 * a tab rather than a path.
 */
import { describe, expect, it } from "vitest";

import { CLOSED_CAP, forget, pop, push, type ClosedTab } from "./closedTabs";

const tab = (path: string, slot = 0): ClosedTab => ({
  projectId: "p1",
  groupId: "g1",
  slot,
  root: "C:/r",
  path,
});

describe("push and pop", () => {
  it("gives back the tab that was closed last", () => {
    const stack = push(push([], tab("a.ts")), tab("b.ts"));

    const step = pop(stack)!;

    expect(step.tab.path).toBe("b.ts");
    expect(step.rest.map((t) => t.path)).toEqual(["a.ts"]);
  });

  it("has nothing to give from an empty stack", () => {
    expect(pop([])).toBeNull();
  });

  it("remembers where the tab lived, not only which file it was", () => {
    // Reopening in the wrong pane is barely better than not reopening.
    const step = pop(push([], tab("a.ts", 3)))!;

    expect(step.tab).toMatchObject({ groupId: "g1", slot: 3, root: "C:/r" });
  });

  it("remembers a comparison as the comparison it was", () => {
    const diff = { ...tab("a.ts"), diff: { source: "draft" as const } };

    expect(pop(push([], diff))!.tab.diff).toEqual({ source: "draft" });
  });

  it("keeps one entry per tab, at its newest position", () => {
    // Open, close, open, close: the same file must not fill the stack.
    let stack = push(push([], tab("a.ts")), tab("b.ts"));
    stack = push(stack, tab("a.ts"));

    expect(stack.map((t) => t.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("tells a comparison apart from the file it compares", () => {
    const file = tab("a.ts");
    const diff = { ...tab("a.ts"), diff: { source: "draft" as const } };

    const stack = push(push([], file), diff);

    expect(stack).toHaveLength(2);
  });

  it("drops the oldest once the stack is full", () => {
    let stack: ClosedTab[] = [];
    for (let i = 0; i < CLOSED_CAP + 3; i++) stack = push(stack, tab(`f${i}.ts`));

    expect(stack).toHaveLength(CLOSED_CAP);
    expect(stack[0].path).toBe("f3.ts");
  });
});

describe("forget", () => {
  it("takes a whole group off the stack when it leaves the workspace", () => {
    // Reopening into a group that no longer exists is a tab with nowhere to
    // go, and the store would have to invent a home for it.
    const other: ClosedTab = { ...tab("c.ts"), groupId: "g2" };
    const stack = push(push([], tab("a.ts")), other);

    expect(forget(stack, (t) => t.groupId === "g1").map((t) => t.path)).toEqual(["c.ts"]);
  });

  it("leaves the stack alone when nothing matches", () => {
    const stack = push([], tab("a.ts"));

    expect(forget(stack, (t) => t.groupId === "nope")).toBe(stack);
  });
});
