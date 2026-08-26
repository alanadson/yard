/**
 * A comparison opened as a tab beside the CLIs — the way VS Code's diff
 * editor opens from source control — is a document like any other, so it
 * needs the two things a document has: an id the bar can key on, and a name
 * that says what is being looked at. The trap is identity: the diff of `a.ts`
 * and `a.ts` itself must be two tabs, and so must its staged and its unstaged
 * sides.
 */
import { describe, expect, it } from "vitest";

import { diffDocId, diffSuffix, parseDiffSpec, type DiffSpec } from "./diffTab";
import { rootedPathKey } from "./roots";

const tree = (side: "worktree" | "index" | "head"): DiffSpec => ({
  source: "tree",
  side,
  origPath: null,
});
const commit = (hash: string): DiffSpec => ({ source: "commit", hash });

describe("diffSuffix", () => {
  it("names the comparison in the user's words, and a commit by its short hash", () => {
    expect(diffSuffix(tree("worktree"))).toBe("Alterações");
    expect(diffSuffix(tree("index"))).toBe("Preparado");
    expect(diffSuffix(tree("head"))).toBe("HEAD");
    expect(diffSuffix(commit("64726be0a1b2c3d4e5f6"))).toBe("64726be");
  });
});

describe("diffDocId", () => {
  it("never collides with the file's own tab, nor with the other side of the same file", () => {
    const own = rootedPathKey("C:\\proj", "src/a.ts");
    const changes = diffDocId("C:\\proj", "src/a.ts", tree("worktree"));
    const staged = diffDocId("C:\\proj", "src/a.ts", tree("index"));
    const inCommit = diffDocId("C:\\proj", "src/a.ts", commit("64726be"));
    expect(new Set([own, changes, staged, inCommit]).size).toBe(4);
  });

  it("is the same id for the same comparison, whichever way the root is spelled", () => {
    expect(diffDocId("C:\\proj", "src/a.ts", tree("worktree"))).toBe(
      diffDocId("c:/proj/", "src/a.ts", tree("worktree")),
    );
  });

  it("two commits touching the same file are two tabs", () => {
    expect(diffDocId("C:\\proj", "a.ts", commit("aaaaaaa"))).not.toBe(
      diffDocId("C:\\proj", "a.ts", commit("bbbbbbb")),
    );
  });
});

describe("parseDiffSpec", () => {
  it("reads back exactly what was written", () => {
    const renamed: DiffSpec = { source: "tree", side: "index", origPath: "old/a.ts" };
    for (const spec of [tree("worktree"), renamed, commit("64726be")]) {
      expect(parseDiffSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
    }
  });

  it("refuses anything it did not write — a stale or hand-edited record must not open a broken tab", () => {
    expect(parseDiffSpec(undefined)).toBeNull();
    expect(parseDiffSpec("worktree")).toBeNull();
    expect(parseDiffSpec({ source: "tree", side: "sideways", origPath: null })).toBeNull();
    expect(parseDiffSpec({ source: "commit" })).toBeNull();
    expect(parseDiffSpec({ source: "commit", hash: 42 })).toBeNull();
  });
});
