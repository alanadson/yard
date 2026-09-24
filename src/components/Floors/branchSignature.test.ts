/**
 * The fronts popover asks `gh` for the pull request of every isolated
 * branch. Its effect used to depend on the group list itself, which is a new
 * array on every layout write, so every pan and every tab switch ran one
 * `gh pr view` per front. A string signature of the branches only changes
 * when a branch appears, leaves or is renamed.
 */
import { describe, expect, it } from "vitest";

import { isolatedBranchSignature } from "./branchSignature";

const front = (branch: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ floor: { kind: "isolated", branch }, ...extra });

describe("isolatedBranchSignature", () => {
  it("the same branches give the same string", () => {
    const a = isolatedBranchSignature([front("feat/a"), front("feat/b")]);
    const b = isolatedBranchSignature([front("feat/a"), front("feat/b")]);
    expect(a).toBe(b);
    expect(a).toContain("feat/a");
  });

  it("a viewport-only change to the layout gives the same string", () => {
    const before = isolatedBranchSignature([front("feat/a", { viewport: { x: 0, y: 0, zoom: 1 } })]);
    const after = isolatedBranchSignature([front("feat/a", { viewport: { x: 50, y: 9, zoom: 2 } })]);
    expect(after).toBe(before);
  });

  it("a new front changes the string", () => {
    const one = isolatedBranchSignature([front("feat/a")]);
    const two = isolatedBranchSignature([front("feat/a"), front("feat/b")]);
    expect(two).not.toBe(one);
  });

  it("ground, plain and branchless floors are left out", () => {
    const sig = isolatedBranchSignature([
      JSON.stringify({ floor: { kind: "ground" } }),
      JSON.stringify({ floor: { kind: "isolated" } }),
      JSON.stringify({}),
    ]);
    expect(sig).toBe("");
  });
});
