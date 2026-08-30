/**
 * A project no longer grows folders.
 *
 * "Novo grupo" made a sibling of the ground that shared the ground's files and
 * the ground's branch: the same working copy under two names, with two agents
 * writing over each other and nothing on screen saying so. What a project
 * grows now is a **front** (a `git worktree` with a branch of its own) and
 * the ground it already has.
 *
 * The failure this locks down is silent by nature. `addGroup` is still on the
 * store (the fallbacks that need *a* group when a project has none still call
 * it, and a board is made by `addBoard`), so putting one call back in the tree
 * would compile, pass every other test, and quietly bring the folders back.
 * There is no DOM in this suite to click the button with; the source is what
 * there is to ask, the same way `Settings/features.test.ts` asks it.
 */
import { describe, expect, it } from "vitest";

import src from "./index.tsx?raw";

describe("the doors of the projects tree", () => {
  it("reads its own source, so a moved file cannot silence the rules below", () => {
    expect(src).toContain("ProjectSidebar");
    expect(src.length).toBeGreaterThan(1000);
  });

  it("has no door that makes a bare group", () => {
    const calls = src
      .split(/\r?\n/)
      .map((line, i): [number, string] => [i + 1, line])
      .filter(([, line]) => /\baddGroup\b/.test(line))
      .map(([n, line]) => `index.tsx:${n}: ${line.trim()}`);
    expect(calls).toEqual([]);
  });

  it("says nothing about a new group any more, not in a menu, not in a balloon", () => {
    expect(src).not.toContain("Novo grupo");
  });

  it("offers the front dialog instead, which is where a branch or a worktree is chosen", () => {
    expect(src).toContain('openModal("new-floor"');
  });

  /** The boards are not project children and keep their own door. */
  it("leaves the boards alone, since a board belongs to no project", () => {
    expect(src).toContain("addBoard");
  });
});
