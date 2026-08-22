/**
 * The top of the Source Control tab has a single button for the remote, and
 * it changes its name with the state of the repository. That is the part that
 * fails quietly: a "Sync" that actually only fetches, a "Publish" offered in a
 * repository with no remote at all, a `2↓ 1↑` counter that stays on screen
 * after the pull. None of that breaks the application — it just makes the
 * person trust the wrong number.
 *
 * The state banner is the neighbour of the same problem: a merge stopped
 * midway changes the meaning of every other button, and if it does not show
 * up the person commits the merge the wrong way without ever being warned.
 */
import { describe, expect, it } from "vitest";

import { branchLabel, stashTitle, stateBanner, syncState } from "./scmHeader";
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

const withRemote = (over: Partial<ScmInfo> = {}) =>
  info({ remotes: [{ name: "origin", url: "https://x.dev/r.git" }], ...over });

describe("syncState", () => {
  it("with no repository there is no remote button", () => {
    expect(syncState(info({ isRepo: false })).kind).toBe("none");
    expect(syncState(null).kind).toBe("none");
  });

  it("a repository with no remote says so, instead of offering to publish to nowhere", () => {
    const s = syncState(info());
    expect(s.kind).toBe("none");
    expect(s.tip).toContain("remoto");
  });

  it("with a remote and no upstream, the invitation is to publish the branch", () => {
    const s = syncState(withRemote());
    expect(s.kind).toBe("publish");
    expect(s.label).toBe("Publicar branch");
    expect(s.disabled).toBe(false);
  });

  it("with an up-to-date upstream, the button fetches — and does not lie that it syncs", () => {
    const s = syncState(withRemote({ upstream: "origin/main" }));
    expect(s.kind).toBe("fetch");
    expect(s.label).toBe("Buscar");
  });

  it("behind and ahead, the button shows both numbers", () => {
    const s = syncState(withRemote({ upstream: "origin/main", ahead: 1, behind: 2 }));
    expect(s.kind).toBe("sync");
    expect(s.label).toBe("2↓ 1↑");
    expect(s.tip).toContain("origin/main");
  });

  it("only ahead is still sync, with a single number", () => {
    const s = syncState(withRemote({ upstream: "origin/main", ahead: 3 }));
    expect(s.kind).toBe("sync");
    expect(s.label).toBe("3↑");
  });

  it("only behind, likewise", () => {
    expect(syncState(withRemote({ upstream: "origin/main", behind: 4 })).label).toBe("4↓");
  });

  it("with a detached HEAD there is no branch to publish or sync", () => {
    const s = syncState(withRemote({ detached: true, branch: null }));
    expect(s.disabled).toBe(true);
    expect(s.tip).toContain("solto");
  });

  it("in the middle of a merge the remote waits — finishing comes first", () => {
    const s = syncState(withRemote({ upstream: "origin/main", state: "merging" }));
    expect(s.disabled).toBe(true);
  });

  it("a repository with no commit at all has nothing to publish", () => {
    const s = syncState(withRemote({ hasHead: false }));
    expect(s.disabled).toBe(true);
    expect(s.tip).toContain("commit");
  });
});

describe("stateBanner", () => {
  it("a clean tree has no banner — the top belongs to the commit, which is the work", () => {
    expect(stateBanner(info())).toBeNull();
    expect(stateBanner(null)).toBeNull();
  });

  it("a stopped merge announces itself and says what to do with it", () => {
    const b = stateBanner(info({ state: "merging" }))!;
    expect(b.title).toContain("Merge");
    expect(b.canAbort).toBe(true);
    // A merge has no `--continue`: it ends with the commit that is already there.
    expect(b.canContinue).toBe(false);
  });

  it("a stopped rebase offers continue AND abort", () => {
    const b = stateBanner(info({ state: "rebasing" }))!;
    expect(b.canContinue).toBe(true);
    expect(b.canAbort).toBe(true);
  });

  it("cherry-pick and revert are states too, not internal details", () => {
    expect(stateBanner(info({ state: "cherry-picking" }))!.canContinue).toBe(true);
    expect(stateBanner(info({ state: "reverting" }))!.canContinue).toBe(true);
    expect(stateBanner(info({ state: "bisecting" }))!.canAbort).toBe(true);
  });

  it("a detached HEAD is a warning on its own — committing there is like losing the work", () => {
    const b = stateBanner(info({ detached: true, branch: null }))!;
    expect(b.title).toContain("solto");
    expect(b.canAbort).toBe(false);
    expect(b.canContinue).toBe(false);
  });
});

describe("branchLabel", () => {
  it("gives the branch name", () => {
    expect(branchLabel(info())).toBe("main");
  });

  it("with a detached HEAD shows the commit you are on, not a made-up name", () => {
    expect(branchLabel(info({ detached: true, branch: null, head: "abc1234" }))).toBe(
      "abc1234",
    );
  });

  it("a newborn repository still names the branch about to be born", () => {
    expect(branchLabel(info({ hasHead: false, head: null, branch: "main" }))).toBe("main");
  });

  it("with no repository there is no label", () => {
    expect(branchLabel(info({ isRepo: false }))).toBe("");
    expect(branchLabel(null)).toBe("");
  });
});

/**
 * Git writes the stash message with the branch inside it ("On main: …",
 * "WIP on feature/x: 1234abc …"). The list already shows the branch in a
 * column of its own, so repeating the prefix spends half the row's width
 * saying what the line below already says — and eats precisely the part the
 * user wrote, which is the only thing that identifies the stash.
 */
describe("stashTitle", () => {
  it("strips the 'On <branch>:' when the branch already shows next to it", () => {
    expect(stashTitle("On main: rascunho do minimapa", "main")).toBe("rascunho do minimapa");
  });

  it("also strips the 'WIP on <branch>:' and the hash git stuffs in with it", () => {
    expect(stashTitle("WIP on feature/x: 1234abc ajustes de css", "feature/x")).toBe(
      "ajustes de css",
    );
  });

  it("with no known branch, leaves the message alone", () => {
    expect(stashTitle("On main: rascunho", null)).toBe("On main: rascunho");
  });

  it("another branch's prefix is not stripped — that would hide where it came from", () => {
    expect(stashTitle("On outra: rascunho", "main")).toBe("On outra: rascunho");
  });

  it("if nothing is left after the cut, shows the whole message", () => {
    expect(stashTitle("On main:", "main")).toBe("On main:");
    expect(stashTitle("WIP on main: 1234abc", "main")).toBe("WIP on main: 1234abc");
  });
});
