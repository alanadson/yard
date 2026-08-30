/**
 * Why these rules matter: the pull request is the one piece of state in this
 * app that belongs to somebody else's server, and the panel reads it at a
 * glance. A chip that says "verde" for a PR whose checks are still running,
 * or a reviewer's comment landing on the wrong file, are both worse than
 * showing nothing at all.
 *
 * The mapping in `reviewFromNotes` is the point of the whole feature: a
 * comment written on GitHub becomes the same annotation row the diff viewer
 * already knows how to hand to an agent.
 */
import { describe, expect, it } from "vitest";

import { prBadge, prTitleFor, reviewFromNotes, shouldRefresh } from "./forge";
import type { PullRequest, ReviewNote } from "./ipc";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: "Uma frente",
  url: "https://github.com/a/b/pull/42",
  state: "OPEN",
  draft: false,
  reviewDecision: "",
  checks: { passed: 0, failed: 0, pending: 0 },
  ...over,
});

describe("prBadge", () => {
  it("counts the checks in the label", () => {
    const badge = prBadge(pr({ checks: { passed: 3, failed: 0, pending: 0 } }));
    expect(badge.label).toContain("3");
    expect(badge.tone).toBe("green");
  });

  /** One red check decides, however many green ones there are. */
  it("is red when anything failed, even with passes alongside", () => {
    expect(prBadge(pr({ checks: { passed: 9, failed: 1, pending: 0 } })).tone).toBe("red");
  });

  it("is yellow while something is still running", () => {
    expect(prBadge(pr({ checks: { passed: 2, failed: 0, pending: 1 } })).tone).toBe("yellow");
  });

  /**
   * The regression this prevents: no checks at all read as "all green".
   * A repository with no CI has nothing to say, and saying "verde" there is
   * inventing a fact.
   */
  it("is neutral when the PR has no checks at all", () => {
    const badge = prBadge(pr());
    expect(badge.tone).toBe("neutral");
    expect(badge.label).not.toContain("0");
  });

  it("a merged PR says so instead of talking about checks", () => {
    expect(prBadge(pr({ state: "MERGED" })).label.toLowerCase()).toContain("merge");
  });

  it("a draft says so — it is not waiting for anybody", () => {
    expect(prBadge(pr({ draft: true })).label.toLowerCase()).toContain("rascunho");
  });

  it("changes requested outranks a green build", () => {
    const badge = prBadge(
      pr({ reviewDecision: "CHANGES_REQUESTED", checks: { passed: 3, failed: 0, pending: 0 } }),
    );
    expect(badge.tone).toBe("yellow");
    expect(badge.label.toLowerCase()).toContain("mudanç");
  });
});

describe("prTitleFor", () => {
  it("turns a branch name into a sentence", () => {
    expect(prTitleFor("yard/busca-no-scrollback")).toBe("Busca no scrollback");
  });

  it("keeps a front's own name when there is one", () => {
    expect(prTitleFor("yard/x", "Busca no histórico")).toBe("Busca no histórico");
  });

  it("survives a branch with nothing to make a sentence out of", () => {
    expect(prTitleFor("")).toBe("");
  });
});

describe("reviewFromNotes", () => {
  const notes: ReviewNote[] = [
    { path: "src/a.ts", line: 12, body: "isso quebra", author: "alguem", url: "u1" },
    { path: "src/b.ts", line: 0, body: "e este arquivo?", author: "outro", url: "u2" },
  ];

  it("becomes the annotation rows the diff viewer already draws", () => {
    const rows = reviewFromNotes(notes, "proj", "D:\\repo", 1000);
    expect(rows).toHaveLength(2);
    expect(rows[0].projectId).toBe("proj");
    expect(rows[0].root).toBe("D:\\repo");
    expect(rows[0].path).toBe("src/a.ts");
    expect(rows[0].line).toBe(12);
  });

  /** Line 0 from GitHub means "no line": the row is about the file. */
  it("a comment with no line is about the file, not about line zero", () => {
    const [, file] = reviewFromNotes(notes, "proj", "D:\\repo", 1000);
    expect(file.line).toBeNull();
  });

  it("says who wrote it — these are somebody else's words, not the user's", () => {
    const [row] = reviewFromNotes(notes, "proj", "D:\\repo", 1000);
    expect(row.body).toContain("alguem");
    expect(row.body).toContain("isso quebra");
  });

  it("stamps them all with the moment they were imported", () => {
    const rows = reviewFromNotes(notes, "proj", "D:\\repo", 1000);
    expect(rows.every((r) => r.createdAt === 1000)).toBe(true);
  });

  it("brings nothing back from an empty review", () => {
    expect(reviewFromNotes([], "proj", "D:\\repo", 1000)).toEqual([]);
  });
});

describe("shouldRefresh", () => {
  /**
   * Every refresh is a `gh` subprocess that talks to GitHub. The panel
   * re-renders on every keystroke of a commit message, and asking the network
   * each time would be both slow and rude.
   */
  it("asks once and then holds for the interval", () => {
    expect(shouldRefresh(undefined, 10_000)).toBe(true);
    expect(shouldRefresh({ checkedAt: 9_000, loading: false }, 10_000)).toBe(false);
    expect(shouldRefresh({ checkedAt: 1_000, loading: false }, 40_000)).toBe(true);
  });

  it("never starts a second call while the first is in flight", () => {
    expect(shouldRefresh({ checkedAt: 0, loading: true }, 999_999)).toBe(false);
  });
});
