/**
 * What the server knows about a front's branch, and what the front's screens
 * are allowed to say about it.
 *
 * Three silent failures live here, and all three cost real work:
 *
 * - a front's branch is created with `--no-track` and never pushed, so
 *   "a frente existe" and "o trabalho da frente está em algum lugar além
 *   deste disco" are different facts. Only the Controle tab knew the second
 *   one, and only for whichever repository the bench happened to be pointed
 *   at;
 * - the base of a new front can be a remote-tracking ref, which is as new as
 *   the last `fetch` and not one commit newer. A front born from a base three
 *   days old is a merge conflict scheduled for later;
 * - closing a front deletes the local branch and leaves the published one
 *   standing. Ten fronts later the server holds ten branches nobody meant to
 *   keep, and the person who has to clean them up is not the one who made
 *   them.
 *
 * Everything here is pure and reads one listing (`scm_branches`), so the
 * decision is testable and the screens only render it.
 */
import { describe, expect, it } from "vitest";

import {
  baseWarningOf,
  baseWarningText,
  publishBadge,
  publishStateOf,
  remoteToDelete,
  splitUpstream,
} from "./floorSync";
import type { ScmBranch } from "./ipc";

const branch = (over: Partial<ScmBranch> = {}): ScmBranch => ({
  name: "yard/login",
  current: false,
  remote: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  hash: "abc1234",
  subject: "work",
  date: 1,
  ...over,
});

describe("what the server knows about a front's branch", () => {
  it("a branch with no upstream exists only on this machine", () => {
    const state = publishStateOf([branch()], "yard/login", true);
    expect(state.kind).toBe("local");
    expect(state.upstream).toBeNull();
  });

  it("commits the server has not seen are counted, not merely flagged", () => {
    const state = publishStateOf(
      [branch({ upstream: "origin/yard/login", ahead: 3 })],
      "yard/login",
      true,
    );
    expect(state).toEqual({ kind: "ahead", ahead: 3, upstream: "origin/yard/login" });
  });

  it("an upstream with nothing ahead is published and quiet", () => {
    const state = publishStateOf(
      [branch({ upstream: "origin/yard/login", ahead: 0, behind: 2 })],
      "yard/login",
      true,
    );
    expect(state).toEqual({ kind: "published", ahead: 0, upstream: "origin/yard/login" });
  });

  it("an upstream deleted on the server is not the same as never having published", () => {
    const state = publishStateOf(
      [branch({ upstream: "origin/yard/login", gone: true })],
      "yard/login",
      true,
    );
    expect(state.kind).toBe("gone");
  });

  it("a repository with no remote has nothing to say about publishing", () => {
    const state = publishStateOf([branch()], "yard/login", false);
    expect(state.kind).toBe("unknown");
  });

  it("a listing that has not arrived yet is unknown, never “só aqui”", () => {
    expect(publishStateOf(null, "yard/login", true).kind).toBe("unknown");
    expect(publishStateOf([], "yard/login", true).kind).toBe("unknown");
  });

  it("a remote branch of the same name does not answer for the local one", () => {
    // `origin/yard/login` is a legal *local* branch name, and matching by name
    // alone let the remote copy (which always has an upstream of its own)
    // report a front as published that had never been pushed.
    const state = publishStateOf(
      [
        branch({ name: "origin/yard/login", remote: true, upstream: "origin/yard/login" }),
        branch({ name: "origin/yard/login", remote: false, upstream: null }),
      ],
      "origin/yard/login",
      true,
    );
    expect(state.kind).toBe("local");
  });
});

describe("the badge a front's row prints", () => {
  it("says nothing when there is nothing to say", () => {
    expect(publishBadge(publishStateOf(null, "yard/login", true), "yard/login")).toBeNull();
  });

  it("names the branch that lives only here, because that is the one at risk", () => {
    const badge = publishBadge({ kind: "local", ahead: 0, upstream: null }, "yard/login");
    expect(badge?.label).toBe("só aqui");
    expect(badge?.tip).toContain("yard/login");
    expect(badge?.tone).toBe("local");
  });

  it("counts what is still owed to the server instead of merely warning", () => {
    const badge = publishBadge(
      { kind: "ahead", ahead: 3, upstream: "origin/yard/login" },
      "yard/login",
    );
    expect(badge?.label).toBe("3 por enviar");
    expect(badge?.tip).toContain("origin/yard/login");
  });

  it("a published branch says where it is published, not just that it is", () => {
    const badge = publishBadge(
      { kind: "published", ahead: 0, upstream: "origin/yard/login" },
      "yard/login",
    );
    expect(badge?.label).toBe("publicada");
    expect(badge?.tip).toContain("origin/yard/login");
    expect(badge?.tone).toBe("published");
  });

  it("an upstream that disappeared reads as a loss, not as a clean state", () => {
    const badge = publishBadge(
      { kind: "gone", ahead: 0, upstream: "origin/yard/login" },
      "yard/login",
    );
    expect(badge?.label).toBe("sumiu do servidor");
    expect(badge?.tone).toBe("gone");
  });
});

/**
 * `git push origin --delete <branch>` needs the two halves separately, and
 * the upstream arrives as one string. A remote name cannot contain a slash
 * (`check_remote_name`, in `scm.rs`), so the first slash is the seam, and
 * everything after it belongs to the branch, slashes included, which is the
 * common shape here: every front is `yard/<something>`.
 */
describe("the two halves of an upstream", () => {
  it("splits at the remote, keeping the branch whole", () => {
    expect(splitUpstream("origin/yard/login")).toEqual({
      remote: "origin",
      branch: "yard/login",
    });
  });

  it("a branch with slashes of its own is not cut short", () => {
    expect(splitUpstream("upstream/yard/fix/login-loop")).toEqual({
      remote: "upstream",
      branch: "yard/fix/login-loop",
    });
  });

  it("nothing to split is nothing to delete", () => {
    expect(splitUpstream(null)).toBeNull();
    expect(splitUpstream("")).toBeNull();
    expect(splitUpstream("origin")).toBeNull();
    expect(splitUpstream("origin/")).toBeNull();
    expect(splitUpstream("/yard/login")).toBeNull();
  });
});

/**
 * Nothing fetches before a front is opened, and that is the right default:
 * the network is slow and the dialog is not the place to hang. What was
 * missing is the sentence: a front grown from `main` three commits behind
 * the server, or from `origin/main` read at the last fetch two days ago, is a
 * conflict scheduled for the day it lands, and the dialog was the last moment
 * anyone could have known.
 */
describe("how new the base of a new front really is", () => {
  it("a base behind the server is said before the front is born", () => {
    const w = baseWarningOf(
      [branch({ name: "main", upstream: "origin/main", behind: 3 })],
      "main",
      true,
    );
    expect(w).toEqual({ kind: "behind", behind: 3, base: "main", upstream: "origin/main" });
    expect(baseWarningText(w)).toContain("3");
    expect(baseWarningText(w)).toContain("origin/main");
  });

  it("a base already up to date does not interrupt anybody", () => {
    const w = baseWarningOf(
      [branch({ name: "main", upstream: "origin/main", behind: 0 })],
      "main",
      true,
    );
    expect(w.kind).toBe("none");
    expect(baseWarningText(w)).toBe("");
  });

  it("a remote base is only as new as the last fetch, and says so", () => {
    const w = baseWarningOf(
      [branch({ name: "origin/main", remote: true, upstream: null })],
      "origin/main",
      true,
    );
    expect(w).toEqual({ kind: "mirror", base: "origin/main" });
    expect(baseWarningText(w)).toContain("origin/main");
  });

  it("with no remote there is nothing to be behind of", () => {
    const w = baseWarningOf(
      [branch({ name: "main", upstream: "origin/main", behind: 3 })],
      "main",
      false,
    );
    expect(w.kind).toBe("none");
  });

  it("a base git will resolve but the listing never named invents no warning", () => {
    // A hash, a tag, `HEAD~2`: all legal bases, none of them a branch.
    expect(baseWarningOf([branch({ name: "main" })], "abc1234", true).kind).toBe("none");
    expect(baseWarningOf([branch({ name: "main" })], "", true).kind).toBe("none");
    expect(baseWarningOf(null, "main", true).kind).toBe("none");
  });
});

/**
 * Which published branch the close dialog may offer to delete. Two states
 * carry an upstream and only one of them is a branch that is really there:
 * `gone` is a ref pointing at something the server no longer has, and
 * offering to delete it promises a `git push --delete` that can only fail.
 */
describe("the branch on the server the close may offer to delete", () => {
  it("offers a published branch, split into the two halves git wants", () => {
    expect(remoteToDelete({ kind: "published", ahead: 0, upstream: "origin/yard/login" })).toEqual(
      { remote: "origin", branch: "yard/login" },
    );
  });

  it("offers it while the front is ahead, the server copy being the older half", () => {
    expect(remoteToDelete({ kind: "ahead", ahead: 4, upstream: "origin/yard/login" })).toEqual({
      remote: "origin",
      branch: "yard/login",
    });
  });

  it("offers nothing when the server no longer has it", () => {
    expect(remoteToDelete({ kind: "gone", ahead: 0, upstream: "origin/yard/login" })).toBeNull();
  });

  it("offers nothing for a branch that was never published", () => {
    expect(remoteToDelete({ kind: "local", ahead: 0, upstream: null })).toBeNull();
    expect(remoteToDelete({ kind: "unknown", ahead: 0, upstream: null })).toBeNull();
  });
});
