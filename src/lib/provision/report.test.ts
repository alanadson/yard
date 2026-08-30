/**
 * How a plan is said out loud to somebody who has no dialog: `yard floor
 * create --dry-run`, and `--json` for whatever is reading the CLI.
 *
 * Two audiences, two rules. The person gets the four lines that decide
 * whether to press enter (the verb, the commit, the branch, the folder) and
 * a refusal printed under the row that caused it, not as a paragraph at the
 * end. The script gets **codes**: `BRANCH_ALREADY_CHECKED_OUT` survives a
 * rewrite of the sentence beside it, and a `grep` for a Portuguese phrase
 * does not.
 */
import { describe, expect, it } from "vitest";

import { issue } from "./errors";
import type { BatchReport, ItemReport } from "./batch";
import type { Plan, PlannedItem } from "./plan";
import { exitCodeOf, planText, runJson, runSummary } from "./report";

const OID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function planned(over: Partial<PlannedItem> = {}): PlannedItem {
  return {
    clientItemId: "a",
    kind: "new_worktree_new_branch",
    action: "create_worktree",
    displayName: "login",
    branch: "yard/login",
    base: { ref: "main", oid: OID },
    path: "C:/proj/.yard/floors/login",
    errors: [],
    warnings: [],
    agentId: null,
    prompt: "",
    ...over,
  };
}

function plan(items: PlannedItem[]): Plan {
  return {
    planId: "plan_1",
    revision: 1,
    createdAt: 1_000,
    expiresAt: 121_000,
    valid: items.every((i) => i.errors.length === 0),
    isRepo: true,
    fingerprint: "fp",
    items,
  };
}

function reported(over: Partial<ItemReport> = {}): ItemReport {
  return {
    clientItemId: "a",
    displayName: "login",
    state: "ready",
    phase: "pronto",
    issue: null,
    warnings: [],
    groupId: "g1",
    path: "C:/proj/.yard/floors/login",
    branch: "yard/login",
    ...over,
  };
}

const report = (items: ItemReport[], state: BatchReport["state"]): BatchReport => ({
  state,
  items,
  journal: { entries: [] },
});

describe("the plan, printed", () => {
  it("gives each front its verb, its commit, its branch and its folder", () => {
    const text = planText(plan([planned()]), { project: "api" });
    expect(text).toContain('1. "login"');
    expect(text).toContain("criar worktree");
    // Short, because a 40-character hash in a terminal buys nothing, but
    // present: the base is a commit and not a moving name.
    expect(text).toContain("main @ a1b2c3d");
    expect(text).toContain("yard/login");
    expect(text).toContain("C:/proj/.yard/floors/login");
  });

  it("says plainly that nothing was written, which is the whole promise of a dry run", () => {
    expect(planText(plan([planned()]), { project: "api" })).toContain("nada foi escrito");
  });

  it("prints a refusal under the row that caused it, not as a paragraph at the end", () => {
    const text = planText(
      plan([
        planned(),
        planned({
          clientItemId: "b",
          displayName: "auth",
          errors: [issue("BRANCH_ALREADY_CHECKED_OUT", { branch: "main", path: "D:/tmp/x" })],
        }),
      ]),
      { project: "api" },
    );
    const rows = text.split(/^\s*\d+\. /m);
    expect(rows[1]).not.toContain("D:/tmp/x");
    expect(rows[2]).toContain("D:/tmp/x");
  });

  it("prints a warning as a warning: it is read, not a refusal", () => {
    const text = planText(plan([planned({ warnings: [issue("WORKTREE_SHARED")] })]), {
      project: "api",
    });
    expect(text).toContain("aviso:");
    expect(text).not.toContain("erro:");
  });

  it("counts what is about to be written, so a batch of twelve is one glance", () => {
    const text = planText(
      plan([planned(), planned({ clientItemId: "b", action: "use_ground", base: null })]),
      { project: "api" },
    );
    expect(text).toMatch(/1 worktree/);
  });
});

describe("the plan, as JSON", () => {
  it("carries codes and not sentences, so a script can branch on the refusal", () => {
    const json = runJson({
      plan: plan([planned({ errors: [issue("BRANCH_ALREADY_EXISTS", { branch: "yard/login" })] })]),
      report: null,
    });
    expect(json.ok).toBe(false);
    expect(json.items[0].errors).toEqual([
      { code: "BRANCH_ALREADY_EXISTS", message: expect.any(String) },
    ]);
    expect(json.state).toBe("planned");
  });

  it("freezes the base as a ref and a commit, which is what the plan approved", () => {
    const json = runJson({ plan: plan([planned()]), report: null });
    expect(json.items[0].base).toEqual({ ref: "main", oid: OID });
    expect(json.planId).toBe("plan_1");
  });

  it("adds what actually happened once something ran", () => {
    const json = runJson({
      plan: plan([planned()]),
      report: report([reported()], "succeeded"),
    });
    expect(json.ok).toBe(true);
    expect(json.state).toBe("succeeded");
    expect(json.items[0]).toMatchObject({ state: "ready", groupId: "g1" });
  });

  /**
   * A batch where three of four came up is not a success and not a failure,
   * and the exit code is what a script reads. Flattening it either way is how
   * a pipeline carries on with a front that never existed.
   */
  it("is not ok when only some of the rows came up", () => {
    const json = runJson({
      plan: plan([planned(), planned({ clientItemId: "b" })]),
      report: report(
        [reported(), reported({ clientItemId: "b", state: "failed", issue: issue("PROVISION_FAILED", { detail: "disco cheio" }) })],
        "partially_succeeded",
      ),
    });
    expect(json.ok).toBe(false);
    expect(json.state).toBe("partially_succeeded");
    expect(json.items[1].errors[0].code).toBe("PROVISION_FAILED");
  });
});

describe("the sentence after a run", () => {
  it("names the front, its branch and its folder when one front came up", () => {
    const line = runSummary({
      plan: plan([planned()]),
      report: report([reported()], "succeeded"),
    });
    expect(line).toContain("login");
    expect(line).toContain("yard/login");
    expect(line).toContain("C:/proj/.yard/floors/login");
  });

  it("says what is left behind when a row ends needing a hand", () => {
    const line = runSummary({
      plan: plan([planned()]),
      report: report(
        [reported({ state: "cleanup_required", issue: issue("ROLLBACK_INCOMPLETE", { detail: "a branch ficou" }) })],
        "cleanup_required",
      ),
    });
    expect(line).toContain("a branch ficou");
    expect(line).toMatch(/limpeza|limpar/i);
  });
});

/**
 * What a shell script reads. The distinction that matters is between "some of
 * it worked" and "something is still on the disk and needs a person": a
 * pipeline that treats the second as the first carries on over a leftover
 * worktree.
 */
describe("the exit code", () => {
  it("is 0 only when every row came up", () => {
    expect(
      exitCodeOf({ plan: plan([planned()]), report: report([reported()], "succeeded") }),
    ).toBe(0);
  });

  it("is 2 when the plan was refused, because nothing was written", () => {
    expect(
      exitCodeOf({
        plan: plan([planned({ errors: [issue("NAME_REQUIRED")] })]),
        report: null,
      }),
    ).toBe(2);
  });

  it("is 0 for a dry run of a plan that would go through: reading is not failing", () => {
    expect(exitCodeOf({ plan: plan([planned()]), report: null })).toBe(0);
  });

  it("is 3 when some rows came up and others did not", () => {
    expect(
      exitCodeOf({
        plan: plan([planned(), planned({ clientItemId: "b" })]),
        report: report(
          [reported(), reported({ clientItemId: "b", state: "failed" })],
          "partially_succeeded",
        ),
      }),
    ).toBe(3);
  });

  it("is 4 when something this run made is still on the disk", () => {
    expect(
      exitCodeOf({
        plan: plan([planned()]),
        report: report([reported({ state: "cleanup_required" })], "cleanup_required"),
      }),
    ).toBe(4);
  });

  it("is 5 when it was cancelled", () => {
    expect(
      exitCodeOf({
        plan: plan([planned()]),
        report: report([reported({ state: "cancelled" })], "cancelled"),
      }),
    ).toBe(5);
  });

  it("is 1 when nothing came up at all, a plain failure", () => {
    expect(
      exitCodeOf({
        plan: plan([planned()]),
        report: report([reported({ state: "failed" })], "failed"),
      }),
    ).toBe(1);
  });
});
