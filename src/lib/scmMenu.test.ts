/**
 * The context menus of the Source Control tab. What gets tested here is not
 * the list of entries — it is **what is greyed out and why**, which is where a
 * menu turns into a trap.
 *
 * The house pattern (the same as `changesMenu`) is not to promise the
 * impossible and still not move the menu around: the entry stays there,
 * greyed out, so the hand does not have to relearn its position. And every
 * greyed-out entry carries its reason, or the user is left with a grey item
 * with no explanation — which is worse than having none.
 */
import { describe, expect, it, vi } from "vitest";

import { scmBranchMenu, scmCommitMenu, scmGroupMenu, scmRowMenu, scmStashMenu } from "./scmMenu";
import { groupChanges } from "./scmGroups";
import type { ChangedFile, ScmBranch, ScmCommit, ScmInfo, ScmStash } from "./ipc";
import type { MenuEntry } from "../components/ContextMenu";

function actions() {
  return {
    openDiff: vi.fn(),
    openInEditor: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    resolve: vi.fn(),
    fileHistory: vi.fn(),
    copyText: vi.fn(),
    reveal: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    discardAll: vi.fn(),
    checkout: vi.fn(),
    createFrom: vi.fn(),
    merge: vi.fn(),
    rebase: vi.fn(),
    rename: vi.fn(),
    deleteBranch: vi.fn(),
    deleteRemote: vi.fn(),
    revert: vi.fn(),
    reset: vi.fn(),
    tag: vi.fn(),
    stashApply: vi.fn(),
    stashDrop: vi.fn(),
    stashShow: vi.fn(),
  };
}

const info = (over: Partial<ScmInfo> = {}): ScmInfo => ({
  isRepo: true,
  root: "C:/proj",
  branch: "main",
  head: "abc1234",
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  remotes: [{ name: "origin", url: "https://x.dev/r.git" }],
  state: "clean",
  stashes: 0,
  hasHead: true,
  ...over,
});

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

const branch = (over: Partial<ScmBranch> = {}): ScmBranch => ({
  name: "feature/x",
  current: false,
  remote: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  hash: "abc1234",
  subject: "algo",
  date: 1,
  ...over,
});

const commit = (over: Partial<ScmCommit> = {}): ScmCommit => ({
  hash: "a".repeat(40),
  short: "aaaaaaa",
  author: "Alan",
  email: "a@x.dev",
  date: 1,
  parents: ["b".repeat(40)],
  refs: [],
  subject: "assunto",
  body: "",
  ...over,
});

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => (e.kind === undefined || e.kind === "item") && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const lineOf = (f: ChangedFile, theGroup = 0) => groupChanges([f])[theGroup].rows[0];

describe("scmRowMenu", () => {
  const ctx = { root: "C:/proj", info: info() };

  it("a row under Changes offers stage and discard", () => {
    const m = scmRowMenu(lineOf(theFile({ path: "a.ts" })), ctx, actions());
    expect(findItem(m, "stage")?.disabled).toBeFalsy();
    expect(findItem(m, "discard")?.disabled).toBeFalsy();
    expect(findItem(m, "unstage")).toBeUndefined();
  });

  it("a row under Staged offers unstage, and does not offer discard", () => {
    const line = lineOf(theFile({ path: "a.ts", index: "modified", worktree: "none" }));
    const m = scmRowMenu(line, ctx, actions());
    expect(findItem(m, "unstage")?.disabled).toBeFalsy();
    expect(findItem(m, "stage")).toBeUndefined();
    // Discarding the staged one would be unstaging AND dropping the change:
    // two gestures under one name. Whoever wants that unstages and discards.
    expect(findItem(m, "discard")).toBeUndefined();
  });

  it("a conflict offers both sides, each by its own name", () => {
    const row = lineOf(
      theFile({
        path: "a.ts",
        status: "conflicted",
        index: "conflicted",
        worktree: "conflicted",
        conflict: "UU",
      }),
    );
    const act = actions();
    const m = scmRowMenu(row, ctx, act);
    findItem(m, "ours")!.onSelect!();
    expect(act.resolve).toHaveBeenCalledWith(row.path, "ours");
    expect(findItem(m, "theirs")).toBeDefined();
  });

  it("a deleted file has nothing to open in the editor or to reveal", () => {
    const line = lineOf(theFile({ path: "a.ts", status: "deleted", worktree: "deleted" }));
    const m = scmRowMenu(line, ctx, actions());
    expect(findItem(m, "editor")?.disabled).toBe(true);
    expect(findItem(m, "reveal")?.disabled).toBe(true);
    // But the diff stays: it is precisely what shows what was lost.
    expect(findItem(m, "diff")?.disabled).toBeFalsy();
  });

  it("a binary does not open in the text editor", () => {
    const line = lineOf(theFile({ path: "img.png", binary: true }));
    expect(findItem(scmRowMenu(line, ctx, actions()), "editor")?.disabled).toBe(true);
  });

  it("copies the relative path and the full one — and the full one needs the root", () => {
    const act = actions();
    const line = lineOf(theFile({ path: "src/a.ts" }));
    findItem(scmRowMenu(line, ctx, act), "copy")!.onSelect!();
    expect(act.copyText).toHaveBeenCalledWith("src/a.ts");

    const noRoot = scmRowMenu(line, { root: null, info: info() }, act);
    expect(findItem(noRoot, "copy-abs")?.disabled).toBe(true);
  });

  it("file history does not exist in a repository with no commit", () => {
    const line = lineOf(theFile({ path: "a.ts" }));
    const m = scmRowMenu(line, { root: "C:/proj", info: info({ hasHead: false }) }, actions());
    expect(findItem(m, "history")?.disabled).toBe(true);
  });

  it("a renamed file also lets you copy the name it came from", () => {
    const act = actions();
    const line = lineOf(
      theFile({
        path: "novo.ts",
        origPath: "velho.ts",
        status: "renamed",
        index: "renamed",
        worktree: "none",
      }),
    );
    findItem(scmRowMenu(line, ctx, act), "copy-orig")!.onSelect!();
    expect(act.copyText).toHaveBeenCalledWith("velho.ts");
  });
});

describe("scmGroupMenu", () => {
  it("Changes offers stage all and discard all", () => {
    const m = scmGroupMenu("changes", { count: 3 }, actions());
    expect(findItem(m, "stage-all")?.disabled).toBeFalsy();
    expect(findItem(m, "discard-all")?.danger).toBe(true);
  });

  it("Staged offers unstage all", () => {
    const m = scmGroupMenu("staged", { count: 2 }, actions());
    expect(findItem(m, "unstage-all")?.disabled).toBeFalsy();
    expect(findItem(m, "discard-all")).toBeUndefined();
  });

  it("an empty group offers no bulk action on nothing", () => {
    expect(findItem(scmGroupMenu("changes", { count: 0 }, actions()), "stage-all")?.disabled).toBe(
      true,
    );
  });
});

describe("scmBranchMenu", () => {
  it("the current branch is neither checked out onto itself nor deleted", () => {
    const m = scmBranchMenu(branch({ current: true, name: "main" }), { info: info() }, actions());
    expect(findItem(m, "checkout")?.disabled).toBe(true);
    expect(findItem(m, "delete")?.disabled).toBe(true);
    expect(findItem(m, "merge")?.disabled).toBe(true);
  });

  it("a remote branch is not checked out: a local one is created from it", () => {
    const act = actions();
    const m = scmBranchMenu(branch({ name: "origin/x", remote: true }), { info: info() }, act);
    expect(findItem(m, "checkout")).toBeUndefined();
    findItem(m, "create-from")!.onSelect!();
    expect(act.createFrom).toHaveBeenCalledWith("origin/x");
    // And renaming a branch that lives on the server is not this menu's business.
    expect(findItem(m, "rename")).toBeUndefined();
  });

  it("delete on the server only shows up when there is a server", () => {
    const withRemote = scmBranchMenu(branch({ upstream: "origin/x" }), { info: info() }, actions());
    expect(findItem(withRemote, "delete-remote")?.disabled).toBeFalsy();
    const without = scmBranchMenu(branch(), { info: info({ remotes: [] }) }, actions());
    expect(findItem(without, "delete-remote")?.disabled).toBe(true);
  });

  it("a branch whose upstream vanished was already merged and deleted there — it can be deleted without force", () => {
    const m = scmBranchMenu(branch({ gone: true, upstream: "origin/x" }), { info: info() }, actions());
    expect(findItem(m, "delete")?.disabled).toBeFalsy();
    expect(findItem(m, "delete")?.label).not.toContain("forçar");
  });

  it("in the middle of a merge you do not switch branches", () => {
    const m = scmBranchMenu(branch(), { info: info({ state: "merging" }) }, actions());
    expect(findItem(m, "checkout")?.disabled).toBe(true);
    expect(findItem(m, "merge")?.disabled).toBe(true);
  });
});

describe("scmCommitMenu", () => {
  it("copies the full hash, not the abbreviated one on screen", () => {
    const act = actions();
    findItem(scmCommitMenu(commit(), { info: info() }, act), "copy-hash")!.onSelect!();
    expect(act.copyText).toHaveBeenCalledWith("a".repeat(40));
  });

  it("all three resets are there, and the hard one is the only one marked as danger", () => {
    const m = scmCommitMenu(commit(), { info: info() }, actions());
    expect(findItem(m, "reset-soft")?.danger).toBeFalsy();
    expect(findItem(m, "reset-mixed")?.danger).toBeFalsy();
    expect(findItem(m, "reset-hard")?.danger).toBe(true);
  });

  it("in the middle of a rebase nothing gets reverted or reset", () => {
    const m = scmCommitMenu(commit(), { info: info({ state: "rebasing" }) }, actions());
    expect(findItem(m, "revert")?.disabled).toBe(true);
    expect(findItem(m, "reset-hard")?.disabled).toBe(true);
  });
});

describe("scmStashMenu", () => {
  const stored: ScmStash = {
    index: 0,
    message: "On main: rascunho",
    branch: "main",
    date: 1,
  };

  it("apply and apply-and-remove are different entries, with different names", () => {
    const act = actions();
    const m = scmStashMenu(stored, actions());
    expect(findItem(m, "apply")?.label).not.toBe(findItem(m, "pop")?.label);
    findItem(scmStashMenu(stored, act), "pop")!.onSelect!();
    expect(act.stashApply).toHaveBeenCalledWith(0, true);
  });

  it("dropping the stash is danger — there is no way to bring it back from the screen", () => {
    expect(findItem(scmStashMenu(stored, actions()), "drop")?.danger).toBe(true);
  });
});
