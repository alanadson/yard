/**
 * The commit button is a single button that does three different things, and
 * what separates the three is the state of the staging area. Getting that
 * wrong means recording a commit different from what the screen promised —
 * the most expensive category of bug there is in a version-control panel,
 * because it only shows up in someone else's `git log`, days later.
 *
 * The three: with something staged it records **what is staged**; with
 * nothing staged but with changes, it stages everything and records; in amend
 * mode it rewrites the last commit — and then there may be nothing staged at
 * all, which is precisely the "I just want to fix the message" case.
 */
import { describe, expect, it } from "vitest";

import { commitAction, messageHint } from "./commitBox";
import type { ScmInfo } from "./ipc";

const info = (over: Partial<ScmInfo> = {}): ScmInfo => ({
  isRepo: true,
  root: "C:/proj",
  branch: "main",
  head: "abc1234",
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  remotes: [],
  state: "clean",
  stashes: 0,
  hasHead: true,
  ...over,
});

const counts = (staged = 0, changes = 0, conflicts = 0) => ({
  staged,
  changes,
  conflicts,
  untracked: 0,
  total: staged + changes + conflicts,
});

describe("commitAction", () => {
  it("with something staged, the button records what is staged", () => {
    const a = commitAction(info(), counts(2, 1), "mensagem", false);
    expect(a.label).toBe("Commit");
    expect(a.stageAll).toBe(false);
    expect(a.disabled).toBe(false);
  });

  it("with nothing staged but with changes, it says it will take everything", () => {
    const a = commitAction(info(), counts(0, 3), "mensagem", false);
    expect(a.label).toBe("Commit de tudo");
    expect(a.stageAll).toBe(true);
    expect(a.disabled).toBe(false);
  });

  it("without a message it does not commit — and says the message is what is missing", () => {
    const a = commitAction(info(), counts(2), "   \n ", false);
    expect(a.disabled).toBe(true);
    expect(a.reason).toContain("mensagem");
  });

  it("with nothing touched there is nothing to record", () => {
    const a = commitAction(info(), counts(0, 0), "mensagem", false);
    expect(a.disabled).toBe(true);
    expect(a.reason).toContain("nada");
  });

  it("an open conflict blocks the commit before anything else", () => {
    const a = commitAction(info({ state: "merging" }), counts(1, 0, 2), "msg", false);
    expect(a.disabled).toBe(true);
    expect(a.reason).toContain("conflito");
  });

  it("in the middle of a merge, with conflicts resolved, the commit is what closes it", () => {
    const a = commitAction(info({ state: "merging" }), counts(3, 0, 0), "merge", false);
    expect(a.disabled).toBe(false);
    expect(a.label).toBe("Commit");
  });

  it("amend rewrites the last commit even with nothing staged", () => {
    const a = commitAction(info(), counts(0, 0), "mensagem melhor", true);
    expect(a.label).toBe("Emendar");
    expect(a.disabled).toBe(false);
    expect(a.stageAll).toBe(false);
  });

  it("amend with something staged takes the staged along, and the label says so", () => {
    const a = commitAction(info(), counts(2, 0), "mensagem", true);
    expect(a.label).toBe("Emendar");
    expect(a.tip).toContain("2");
  });

  it("there is nothing to amend in a repository with no commit at all", () => {
    const a = commitAction(info({ hasHead: false, head: null }), counts(1), "msg", true);
    expect(a.disabled).toBe(true);
    expect(a.reason).toContain("commit");
  });

  it("without a repository the button does not exist", () => {
    const a = commitAction(info({ isRepo: false }), counts(0), "msg", false);
    expect(a.disabled).toBe(true);
  });

  it("with a detached HEAD you can still commit, but the warning comes along", () => {
    const a = commitAction(info({ detached: true, branch: null }), counts(1), "m", false);
    expect(a.disabled).toBe(false);
    expect(a.warning).toContain("branch");
  });

  it("on a branch, no warning at all", () => {
    expect(commitAction(info(), counts(1), "m", false).warning).toBeNull();
  });
});

describe("messageHint", () => {
  it("a short message gets no hint", () => {
    expect(messageHint("corrige o merge de andares")).toBeNull();
    expect(messageHint("")).toBeNull();
  });

  it("an overlong subject is pointed out, without blocking anything", () => {
    expect(messageHint("x".repeat(80))).toContain("assunto");
  });

  it("a body glued to the subject is the classic mistake — git treats both as one", () => {
    expect(messageHint("assunto\ncorpo")).toContain("linha em branco");
  });

  it("subject, blank line, body: the right shape gets no hint", () => {
    expect(messageHint("assunto\n\ncorpo com o porquê")).toBeNull();
  });
});
