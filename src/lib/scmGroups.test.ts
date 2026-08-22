/**
 * `git status` arrives as a flat list; the Source Control tab shows three
 * groups. The translation between the two is where the error nobody sees
 * lives: the index and the disk are **two independent sides**, and the same
 * file can be on both at once (staged it, touched it again). While that was a
 * single boolean, half the work vanished from the screen at commit time — and
 * the commit came out different from what the list promised.
 *
 * The other error is vocabulary: a conflict is not "modified". It is a third
 * state, with a pair of letters (`UU`, `DU`, `UA`) that says which of the six
 * fights happened — and each one asks for a different resolution.
 */
import { describe, expect, it } from "vitest";

import {
  SCM_ROWS_PAGE,
  conflictKind,
  groupChanges,
  pageRows,
  scmCounts,
} from "./scmGroups";
import type { ChangedFile } from "./ipc";

const theFile = (over: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  origPath: null,
  status: "modified",
  staged: false,
  additions: 1,
  deletions: 0,
  binary: false,
  index: "none",
  worktree: "modified",
  conflict: null,
  ...over,
});

describe("groupChanges", () => {
  it("a file touched only on disk goes under Changes", () => {
    const groups = groupChanges([theFile({ path: "a.ts" })]);
    expect(groups.map((g) => g.id)).toEqual(["changes"]);
    expect(groups[0].rows.map((r) => r.path)).toEqual(["a.ts"]);
  });

  it("a staged file goes under Staged, with the index's verb", () => {
    const groups = groupChanges([
      theFile({ path: "a.ts", index: "added", worktree: "none", status: "added" }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["staged"]);
    expect(groups[0].rows[0].status).toBe("added");
  });

  it("staged AND touched again shows up in BOTH groups — it is different work in each", () => {
    const groups = groupChanges([
      theFile({ path: "a.ts", index: "modified", worktree: "modified" }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["staged", "changes"]);
    expect(groups[0].rows[0].path).toBe("a.ts");
    expect(groups[1].rows[0].path).toBe("a.ts");
    // Two rows, two destinations: the key must not collide or React merges the two.
    expect(groups[0].rows[0].key).not.toBe(groups[1].rows[0].key);
  });

  it("each side shows its own verb, not the other's", () => {
    const groups = groupChanges([
      theFile({ path: "a.ts", index: "added", worktree: "deleted", status: "added" }),
    ]);
    expect(groups[0].rows[0].status).toBe("added");
    expect(groups[1].rows[0].status).toBe("deleted");
  });

  it("a new file goes under Changes marked as untracked", () => {
    const groups = groupChanges([
      theFile({ path: "novo.md", status: "untracked", worktree: "untracked" }),
    ]);
    expect(groups[0].id).toBe("changes");
    expect(groups[0].rows[0].untracked).toBe(true);
    expect(groups[0].rows[0].status).toBe("untracked");
  });

  it("a conflict goes only under Conflicts — it is not 'modified' anywhere", () => {
    const groups = groupChanges([
      theFile({
        path: "briga.ts",
        status: "conflicted",
        index: "conflicted",
        worktree: "conflicted",
        conflict: "UU",
      }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["conflicts"]);
    expect(groups[0].rows[0].conflict).toBe("UU");
  });

  it("the groups always come out in the same order: conflicts, staged, changes", () => {
    const groups = groupChanges([
      theFile({ path: "z.ts" }),
      theFile({ path: "b.ts", index: "modified", worktree: "none" }),
      theFile({
        path: "c.ts",
        status: "conflicted",
        index: "conflicted",
        worktree: "conflicted",
        conflict: "AA",
      }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["conflicts", "staged", "changes"]);
  });

  it("an empty group does not become a stray header on screen", () => {
    expect(groupChanges([]).length).toBe(0);
  });

  it("within a group the order is by path, so the hand always finds things in the same place", () => {
    const groups = groupChanges([
      theFile({ path: "src/z.ts" }),
      theFile({ path: "src/a.ts" }),
      theFile({ path: "b.ts" }),
    ]);
    expect(groups[0].rows.map((r) => r.path)).toEqual(["b.ts", "src/a.ts", "src/z.ts"]);
  });

  it("each row already knows what it can do — the button does not ask the group", () => {
    const [staged, changes] = groupChanges([
      theFile({ path: "a.ts", index: "modified", worktree: "modified" }),
    ]);
    expect(staged.rows[0].canUnstage).toBe(true);
    expect(staged.rows[0].canStage).toBe(false);
    expect(staged.rows[0].canDiscard).toBe(false);
    expect(changes.rows[0].canStage).toBe(true);
    expect(changes.rows[0].canDiscard).toBe(true);
    expect(changes.rows[0].canUnstage).toBe(false);
  });

  it("each row's side is what the diff has to ask the backend for", () => {
    const [staged, changes] = groupChanges([
      theFile({ path: "a.ts", index: "modified", worktree: "modified" }),
    ]);
    expect(staged.rows[0].side).toBe("index");
    expect(changes.rows[0].side).toBe("worktree");
  });

  it("a renamed file carries the old name on both sides", () => {
    const groups10 = groupChanges([
      theFile({
        path: "novo/lugar.ts",
        origPath: "antigo/lugar.ts",
        status: "renamed",
        index: "renamed",
        worktree: "none",
      }),
    ]);
    expect(groups10[0].rows[0].origPath).toBe("antigo/lugar.ts");
  });
});

describe("scmCounts", () => {
  it("counts each side on its own and the total by distinct file", () => {
    const counts = scmCounts([
      theFile({ path: "a.ts", index: "modified", worktree: "modified" }),
      theFile({ path: "b.ts", index: "added", worktree: "none" }),
      theFile({ path: "c.ts" }),
      theFile({
        path: "d.ts",
        status: "conflicted",
        index: "conflicted",
        worktree: "conflicted",
        conflict: "UU",
      }),
    ]);
    expect(counts.staged).toBe(2);
    expect(counts.changes).toBe(2);
    expect(counts.conflicts).toBe(1);
    // a, b, c, d — the file on both sides counts only once in the total.
    expect(counts.total).toBe(4);
  });

  it("with nothing touched, everything is zero — the total too", () => {
    expect(scmCounts([])).toEqual({
      staged: 0,
      changes: 0,
      conflicts: 0,
      untracked: 0,
      total: 0,
    });
  });

  /**
   * The "discard all" warning has to separate what **goes back** to the last
   * commit from what **vanishes from disk**. They are different consequences,
   * and the number of new files cannot be derived from any of the other
   * counters: `changes` includes the new ones, `staged` says nothing about them.
   */
  it("counts new files separately — it is what the discard warning needs", () => {
    const counts = scmCounts([
      theFile({ path: "a.ts" }),
      theFile({ path: "novo.md", status: "untracked", worktree: "untracked" }),
      theFile({ path: "outro.md", status: "untracked", worktree: "untracked" }),
    ]);
    expect(counts.untracked).toBe(2);
    expect(counts.changes).toBe(3);
  });
});

describe("conflictKind", () => {
  it("names each of the six fights instead of repeating 'conflict'", () => {
    expect(conflictKind("UU")).toBe("os dois mexeram");
    expect(conflictKind("AA")).toBe("os dois adicionaram");
    expect(conflictKind("DD")).toBe("os dois apagaram");
    expect(conflictKind("DU")).toBe("eu apaguei, eles mexeram");
    expect(conflictKind("UD")).toBe("eu mexi, eles apagaram");
    expect(conflictKind("AU")).toBe("só eu adicionei");
    expect(conflictKind("UA")).toBe("só eles adicionaram");
  });

  it("a pair git never wrote does not make up a story", () => {
    expect(conflictKind("XY")).toBe("conflito");
    expect(conflictKind(null)).toBe("conflito");
  });
});

/**
 * The window of rows.
 *
 * The regression that motivated this: in a repository with two thousand
 * touched files (an `npm install`, a `cargo build` without `.gitignore`, a big
 * rebase), the Source Control tab drew **one DOM row per file** — each with
 * four buttons, three SVG icons and four `data-tip` tooltips. It went past
 * fifty thousand nodes, and the app froze when opening the tab and on every
 * click. The list now comes out by page, and what is left over is counted out
 * loud: a list truncated in silence lies about the size of the work.
 */
describe("pageRows", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

  it("two thousand files do not become two thousand nodes — one page comes out and the rest is counted", () => {
    const page = pageRows(lines(2000), SCM_ROWS_PAGE);
    expect(page.rows).toHaveLength(SCM_ROWS_PAGE);
    expect(page.hidden).toBe(2000 - SCM_ROWS_PAGE);
  });

  it("what fits whole gets no 'show more' footer", () => {
    const page = pageRows(lines(12), SCM_ROWS_PAGE);
    expect(page.rows).toHaveLength(12);
    expect(page.hidden).toBe(0);
  });

  it("show more reveals the next page without losing the beginning", () => {
    const all = lines(500);
    const page = pageRows(all, SCM_ROWS_PAGE * 2);
    expect(page.rows[0]).toBe("f0");
    expect(page.rows).toHaveLength(SCM_ROWS_PAGE * 2);
    expect(page.hidden).toBe(100);
  });

  it("asking for more than exists returns everything, and no negative 'hidden'", () => {
    const page = pageRows(lines(30), 4000);
    expect(page.rows).toHaveLength(30);
    expect(page.hidden).toBe(0);
  });

  it("the list is the same reference when nobody was cut — no array recreated for nothing", () => {
    const everything = lines(30);
    expect(pageRows(everything, SCM_ROWS_PAGE).rows).toBe(everything);
  });
});
