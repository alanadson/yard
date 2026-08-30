/**
 * A failed provisioning used to reach the screen as whatever `git` wrote to
 * stderr: "fatal: 'main' is already checked out at '/c/...'" — a sentence
 * that names a path the person never typed, in a language the app does not
 * speak, with no way forward in it. The catalogue is the fix: every refusal
 * has a **stable code** the UI can key on, a severity that says whether it
 * blocks the button or only asks to be acknowledged, and a sentence written
 * for the person who is about to click.
 *
 * The code is the contract. The sentence may be rewritten, translated, or
 * shortened; the code is what a test, a log line and a retry decision are
 * allowed to depend on.
 */
import { describe, expect, it } from "vitest";

import {
  CODES,
  blockers,
  isBlocking,
  issue,
  issueText,
  isRetryable,
  notices,
  type ProvisionIssue,
} from "./errors";

describe("the provisioning error catalogue", () => {
  it("every code carries a severity and a sentence with at least one letter", () => {
    for (const code of CODES) {
      const i = issue(code);
      expect(issueText(i), code).toMatch(/\p{L}/u);
      expect(typeof isBlocking(i), code).toBe("boolean");
    }
  });

  it("interpolates the values into the sentence, so no {branch} reaches the screen", () => {
    const i = issue("BRANCH_ALREADY_CHECKED_OUT", { branch: "main", path: "C:/repo" });
    expect(issueText(i)).toContain("main");
    expect(issueText(i)).toContain("C:/repo");
    expect(issueText(i)).not.toContain("{");
  });

  it("an unfilled placeholder stays visible instead of printing undefined", () => {
    expect(issueText(issue("BRANCH_ALREADY_EXISTS"))).toContain("{branch}");
  });

  it("a branch already checked out blocks; a shared destination only warns", () => {
    expect(isBlocking(issue("BRANCH_ALREADY_CHECKED_OUT"))).toBe(true);
    expect(isBlocking(issue("WORKTREE_SHARED"))).toBe(false);
  });

  it("splits a mixed list into what blocks the button and what only asks to be read", () => {
    const list: ProvisionIssue[] = [
      issue("WORKTREE_SHARED"),
      issue("NAME_TAKEN", { name: "login" }),
      issue("GROUND_IN_USE"),
    ];
    expect(blockers(list).map((i) => i.code)).toEqual(["NAME_TAKEN"]);
    expect(notices(list).map((i) => i.code)).toEqual(["WORKTREE_SHARED", "GROUND_IN_USE"]);
  });

  it("a stale plan is worth retrying; a name already taken is not", () => {
    // The difference decides whether the progress screen offers "Tentar de
    // novo" or sends the person back to the field they have to change.
    expect(isRetryable(issue("PLAN_STALE"))).toBe(true);
    expect(isRetryable(issue("NAME_TAKEN"))).toBe(false);
  });

  it("carries the field to focus, when the refusal is about a field", () => {
    expect(issue("NAME_REQUIRED").field).toBe("name");
    expect(issue("BRANCH_INVALID", { branch: "-x" }).field).toBe("branch");
    expect(issue("PLAN_STALE").field).toBeUndefined();
  });
});
