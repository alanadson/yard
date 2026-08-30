/**
 * A matrix of agents needs a name per row, and typing four of them by hand
 * is how two rows end up asking for the same branch — which git answers, at
 * the very end, with a refusal about a path. So the rows are named from a
 * pattern, and the pattern's output is made unique against everything already
 * spoken for *in the same batch*, which is the one collision the backend
 * cannot see: it is asked one question at a time and each answer is "free".
 */
import { describe, expect, it } from "vitest";

import { branchSlug, expandPattern, uniqueIn } from "./naming";

describe("naming a row of the matrix", () => {
  it("fills {agent} and {index}, counting from one", () => {
    expect(expandPattern("exp-{agent}-{index}", { agent: "codex", index: 0 })).toBe("exp-codex-1");
    expect(expandPattern("exp-{agent}-{index}", { agent: "claude", index: 1 })).toBe("exp-claude-2");
  });

  it("fills {name} with the batch's shared name", () => {
    expect(expandPattern("{name}-{index}", { name: "login", agent: "codex", index: 0 })).toBe(
      "login-1",
    );
  });

  it("leaves a placeholder nobody filled visible, instead of printing undefined", () => {
    expect(expandPattern("{nope}-{index}", { agent: "a", index: 0 })).toBe("{nope}-1");
  });

  it("a pattern with no placeholder is a literal, and every row would collide on it", () => {
    // Which is exactly why `uniqueIn` exists, and why the matrix runs both.
    expect(expandPattern("login", { agent: "codex", index: 3 })).toBe("login");
  });
});

describe("a branch name out of a written name", () => {
  it("lowercases, transliterates and hyphenates — the slug the backend would build", () => {
    expect(branchSlug("Correção do Login")).toBe("correcao-do-login");
  });

  it("keeps the bar, because a branch is allowed to have folders", () => {
    expect(branchSlug("yard/fix Login")).toBe("yard/fix-login");
  });

  it("never ends on a hyphen, a bar or a dot — git refuses all three", () => {
    expect(branchSlug("login...")).toBe("login");
    expect(branchSlug("login/")).toBe("login");
    expect(branchSlug("  --login--  ")).toBe("login");
  });

  it("a name made only of punctuation still answers something usable", () => {
    expect(branchSlug("!!!")).toBe("frente");
  });
});

describe("uniqueness inside one batch", () => {
  it("returns the candidate untouched when nobody else asked for it", () => {
    expect(uniqueIn("login", new Set())).toBe("login");
  });

  it("suffixes with -2, then -3, walking past every taken one", () => {
    expect(uniqueIn("login", new Set(["login"]))).toBe("login-2");
    expect(uniqueIn("login", new Set(["login", "login-2"]))).toBe("login-3");
  });

  it("compares without case, because Windows does — two folders, one name", () => {
    expect(uniqueIn("Login", new Set(["login"]))).toBe("Login-2");
  });
});
