/**
 * Running a plan. Everything that can go wrong halfway through, and what is
 * left on the disk when it does.
 *
 * The rules being locked here are the expensive ones, the ones whose failure
 * never shows up on screen:
 *
 * - an operation removes only what **it** created, read from its own journal
 *   — never "the folder at that path", which may be a week old;
 * - a branch that received a commit is never deleted, whatever the policy
 *   says: it is the only place that work exists;
 * - an agent that fails to start does not take its worktree down with it —
 *   the front is there, and pressing the button again must not build it twice;
 * - a failure in row 2 does not silently undo row 1, and does not silently
 *   continue either. Which of the two happens is the policy, and the policy
 *   is the person's choice, not a default buried in a catch block.
 *
 * The effects are injected, so all of it runs with no git, no disk and no
 * clock — and the order of the calls is itself an assertion.
 */
import { describe, expect, it } from "vitest";

import type { Preflight } from "../ipc";
import { cleanupItems, runBatch, type ProvisionEffects } from "./batch";
import { buildPlan, type Plan, type PlanWorld, type TargetSpec } from "./plan";

const OID = "a".repeat(40);

const PREFLIGHT: Preflight = {
  isRepo: true,
  hasHead: true,
  groundPath: "C:/proj",
  groundBranch: "main",
  groundDirty: false,
  defaultBase: "main",
  localBranches: ["main"],
  worktrees: [{ path: "C:/proj", branch: "main", bare: false }],
  items: [],
};

const WORLD: PlanWorld = {
  takenNames: [],
  ownedPaths: {},
  busyPaths: {},
  availableAgents: ["codex", "claude"],
};

/** A plan for N rows that all create a worktree, named `a`, `b`, `c`… */
function planFor(
  specs: Array<Partial<TargetSpec> & { clientItemId: string }>,
  over: Partial<Preflight> = {},
): Plan {
  const full: TargetSpec[] = specs.map((s) => ({
    kind: "new_worktree_new_branch",
    displayName: s.clientItemId,
    ...s,
  }));
  const preflight: Preflight = {
    ...PREFLIGHT,
    ...over,
    items:
      over.items ??
      full.map((s) => ({
        id: s.clientItemId,
        branch: s.kind === "existing_worktree" ? "yard/solta" : `yard/${s.displayName}`,
        branchExists: s.kind === "existing_worktree",
        branchCheckedOutAt: s.kind === "existing_worktree" ? s.worktreePath! : null,
        branchError: null,
        path: s.worktreePath ?? `C:/proj/.yard/floors/${s.displayName}`,
        pathExists: s.kind === "existing_worktree",
        baseRef: s.kind === "new_worktree_new_branch" ? "main" : null,
        baseOid: s.kind === "new_worktree_new_branch" ? OID : null,
        locked: null,
        dirty: null,
      })),
  };
  return buildPlan({ planId: "p", revision: 1, now: 1_000, specs: full, preflight, world: WORLD });
}

interface Fake extends ProvisionEffects {
  calls: string[];
  /** Effect name → the error it should throw, once. */
  fail: Record<string, string>;
  /** Branches whose compare-and-swap delete comes back "it moved". */
  moved: Set<string>;
  concurrent: number;
  peak: number;
}

function fakeEffects(over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    calls: [],
    fail: {},
    moved: new Set(),
    concurrent: 0,
    peak: 0,
    refresh: async () => PREFLIGHT,
    createWorktree: async (item) => {
      f.calls.push(`create:${item.clientItemId}`);
      f.concurrent += 1;
      f.peak = Math.max(f.peak, f.concurrent);
      await Promise.resolve();
      f.concurrent -= 1;
      if (f.fail[`create:${item.clientItemId}`]) throw new Error(f.fail[`create:${item.clientItemId}`]);
      return { path: item.path, branch: item.branch, headOid: OID };
    },
    registerGroup: async (item) => {
      f.calls.push(`group:${item.clientItemId}`);
      if (f.fail[`group:${item.clientItemId}`]) throw new Error(f.fail[`group:${item.clientItemId}`]);
      return `g-${item.clientItemId}`;
    },
    runSetup: async (item) => {
      f.calls.push(`setup:${item.clientItemId}`);
      if (f.fail[`setup:${item.clientItemId}`]) throw new Error(f.fail[`setup:${item.clientItemId}`]);
    },
    launchAgent: async (item) => {
      f.calls.push(`agent:${item.clientItemId}`);
      if (f.fail[`agent:${item.clientItemId}`]) throw new Error(f.fail[`agent:${item.clientItemId}`]);
      return `t-${item.clientItemId}`;
    },
    removeWorktree: async (path) => {
      f.calls.push(`rm:${path}`);
      if (f.fail[`rm:${path}`]) throw new Error(f.fail[`rm:${path}`]);
    },
    deleteBranch: async (branch) => {
      f.calls.push(`branch-rm:${branch}`);
      return !f.moved.has(branch);
    },
    dropGroup: async (groupId) => {
      f.calls.push(`drop:${groupId}`);
    },
    stopAgent: async (id) => {
      f.calls.push(`stop:${id}`);
    },
    ...over,
  };
  return f;
}

const run = (plan: Plan, effects: ProvisionEffects, over: Partial<Parameters<typeof runBatch>[0]> = {}) =>
  runBatch({ plan, effects, policy: "continue", now: () => 1_100, ...over });

describe("running one row", () => {
  it("creates, registers, sets up and launches — in that order", async () => {
    const f = fakeEffects();
    const report = await run(planFor([{ clientItemId: "a", prompt: "faça" }]), f);
    expect(f.calls).toEqual(["create:a", "group:a", "setup:a", "agent:a"]);
    expect(report.state).toBe("succeeded");
    expect(report.items[0].state).toBe("ready");
    expect(report.items[0].groupId).toBe("g-a");
  });

  it("reports every phase it walks through, so the screen is never a spinner", async () => {
    const seen: string[] = [];
    await run(planFor([{ clientItemId: "a" }]), fakeEffects(), {
      onProgress: (r) => seen.push(`${r.items[0].state}:${r.items[0].phase}`),
    });
    expect(seen).toContain("running:criando");
    expect(seen).toContain("running:iniciando");
    expect(seen[seen.length - 1]).toBe("ready:pronto");
  });

  it("adopts without creating: nothing is written, so nothing is in the journal to undo", async () => {
    const f = fakeEffects();
    const plan = planFor([
      { clientItemId: "a", kind: "existing_worktree", worktreePath: "C:/proj/.yard/floors/solta" },
    ]);
    const report = await run(plan, f);
    expect(f.calls).toEqual(["group:a", "setup:a", "agent:a"]);
    expect(report.journal.entries.some((e) => e.effect === "worktree_created")).toBe(false);
  });

  it("uses the ground without creating a group of its own", async () => {
    const f = fakeEffects();
    const plan = planFor([{ clientItemId: "a", kind: "current_workspace" }], {
      items: [
        {
          id: "a",
          branch: "main",
          branchExists: true,
          branchCheckedOutAt: "C:/proj",
          branchError: null,
          path: "C:/proj",
          pathExists: true,
          baseRef: null,
          baseOid: null,
          locked: null,
          dirty: null,
        },
      ],
    });
    const report = await run(plan, f);
    expect(f.calls).not.toContain("create:a");
    expect(report.items[0].state).toBe("ready");
  });
});

describe("before it writes anything", () => {
  it("refuses a plan that expired while it sat on the screen", async () => {
    const f = fakeEffects();
    const report = await run(planFor([{ clientItemId: "a" }]), f, { now: () => 9_000_000 });
    expect(f.calls).toEqual([]);
    expect(report.items[0].issue?.code).toBe("PLAN_STALE");
    expect(report.state).toBe("failed");
  });

  it("refuses a plan the repository moved out from under — a branch created in another window", async () => {
    const f = fakeEffects({
      refresh: async () => ({ ...PREFLIGHT, localBranches: ["main", "yard/a"] }),
    });
    const report = await run(planFor([{ clientItemId: "a" }]), f);
    expect(f.calls).toEqual([]);
    expect(report.items[0].issue?.code).toBe("PLAN_STALE");
  });

  it("refuses a row that the plan itself had already blocked", async () => {
    const f = fakeEffects();
    const plan = planFor([{ clientItemId: "a", displayName: "  " }]);
    expect(plan.valid).toBe(false);
    const report = await run(plan, f);
    expect(f.calls).toEqual([]);
    expect(report.items[0].issue?.code).toBe("NAME_REQUIRED");
  });
});

describe("one repository at a time", () => {
  it("never has two mutations in flight — git serialises anyway, and badly", async () => {
    const f = fakeEffects();
    await run(planFor([{ clientItemId: "a" }, { clientItemId: "b" }, { clientItemId: "c" }]), f);
    expect(f.peak).toBe(1);
    expect(f.calls.filter((c) => c.startsWith("create:"))).toEqual(["create:a", "create:b", "create:c"]);
  });
});

describe("when a row fails while creating", () => {
  it("undoes its own worktree and its own branch, in that order", async () => {
    const f = fakeEffects({ fail: { "group:a": "banco fora do ar" } });
    const report = await run(planFor([{ clientItemId: "a" }]), f);
    expect(f.calls).toEqual([
      "create:a",
      "group:a",
      "rm:C:/proj/.yard/floors/a",
      "branch-rm:yard/a",
    ]);
    expect(report.items[0].state).toBe("rolled_back");
    expect(report.state).toBe("failed");
  });

  it("keeps a branch that moved — an agent committed to it and that work exists nowhere else", async () => {
    const f = fakeEffects({ fail: { "group:a": "erro" }, moved: new Set(["yard/a"]) });
    const report = await run(planFor([{ clientItemId: "a" }]), f);
    expect(report.items[0].state).toBe("cleanup_required");
    expect(report.state).toBe("cleanup_required");
  });

  it("leaves cleanup_required when the folder itself refuses to go", async () => {
    const f = fakeEffects({
      fail: { "group:a": "erro", "rm:C:/proj/.yard/floors/a": "arquivo em uso" },
    });
    const report = await run(planFor([{ clientItemId: "a" }]), f);
    expect(report.items[0].state).toBe("cleanup_required");
    // And it never went on to delete the branch of a worktree still standing.
    expect(f.calls).not.toContain("branch-rm:yard/a");
  });

  it("never removes a worktree it only adopted", async () => {
    const f = fakeEffects({ fail: { "group:a": "erro" } });
    const plan = planFor([
      { clientItemId: "a", kind: "existing_worktree", worktreePath: "C:/proj/.yard/floors/solta" },
    ]);
    const report = await run(plan, f);
    expect(f.calls.some((c) => c.startsWith("rm:"))).toBe(false);
    expect(report.items[0].state).toBe("rolled_back");
  });
});

describe("when the agent is the thing that fails", () => {
  it("keeps the front standing: it is built, and pressing the button again must not build it twice", async () => {
    const f = fakeEffects({ fail: { "agent:a": "spawn falhou" } });
    const report = await run(planFor([{ clientItemId: "a" }]), f);
    expect(f.calls).toEqual(["create:a", "group:a", "setup:a", "agent:a"]);
    expect(report.items[0].state).toBe("failed");
    expect(report.items[0].issue?.code).toBe("AGENT_LAUNCH_FAILED");
    expect(report.items[0].groupId).toBe("g-a");
  });
});

describe("when the setup is the thing that fails", () => {
  it("blocks the agent by default: a front with no dependencies installed wastes a whole run", async () => {
    const f = fakeEffects({ fail: { "setup:a": "npm ci saiu 1" } });
    const report = await run(planFor([{ clientItemId: "a" }]), f);
    expect(f.calls).not.toContain("agent:a");
    expect(report.items[0].issue?.code).toBe("SETUP_FAILED");
    expect(report.items[0].state).toBe("failed");
  });

  it("only warns, and starts the agent anyway, when the row asked for that", async () => {
    const f = fakeEffects({ fail: { "setup:a": "npm ci saiu 1" } });
    const report = await run(planFor([{ clientItemId: "a" }]), f, { setupPolicy: "run_parallel" });
    expect(f.calls).toContain("agent:a");
    expect(report.items[0].state).toBe("ready");
    expect(report.items[0].warnings.map((w) => w.code)).toContain("SETUP_FAILED");
  });

  it("skips it entirely when asked to", async () => {
    const f = fakeEffects();
    await run(planFor([{ clientItemId: "a" }]), f, { setupPolicy: "skip" });
    expect(f.calls).not.toContain("setup:a");
  });
});

describe("the policy for the rows that follow a failure", () => {
  const two = () => planFor([{ clientItemId: "a" }, { clientItemId: "b" }]);

  it("continue: row b is built anyway, and the batch says it only half worked", async () => {
    const f = fakeEffects({ fail: { "create:a": "disco cheio" } });
    const report = await run(two(), f, { policy: "continue" });
    expect(f.calls).toContain("create:b");
    expect(report.state).toBe("partially_succeeded");
    expect(report.items.map((i) => i.state)).toEqual(["rolled_back", "ready"]);
  });

  it("stop_pending: row b never starts, and what row a made is kept as it is", async () => {
    const f = fakeEffects({ fail: { "agent:a": "spawn falhou" } });
    const report = await run(two(), f, { policy: "stop_pending" });
    expect(f.calls).not.toContain("create:b");
    expect(report.items[1].state).toBe("cancelled");
    // Row a's worktree is standing: stopping is not undoing.
    expect(f.calls).not.toContain("rm:C:/proj/.yard/floors/a");
  });

  it("compensate_created: the rows that had worked are undone too, last first", async () => {
    const f = fakeEffects({ fail: { "create:b": "disco cheio" } });
    const report = await run(two(), f, { policy: "compensate_created" });
    expect(f.calls.slice(f.calls.indexOf("create:b") + 1)).toEqual([
      "stop:t-a",
      "drop:g-a",
      "rm:C:/proj/.yard/floors/a",
      "branch-rm:yard/a",
    ]);
    expect(report.items[0].state).toBe("rolled_back");
    expect(report.state).toBe("failed");
  });

  it("compensate_created keeps any row whose branch has work on it, and says so", async () => {
    const f = fakeEffects({ fail: { "create:b": "erro" }, moved: new Set(["yard/a"]) });
    const report = await run(two(), f, { policy: "compensate_created" });
    expect(report.items[0].state).toBe("cleanup_required");
    expect(report.state).toBe("cleanup_required");
  });
});

describe("cancelling", () => {
  it("stops the rows that have not started and keeps the ones that finished", async () => {
    const f = fakeEffects();
    let done = 0;
    const report = await run(planFor([{ clientItemId: "a" }, { clientItemId: "b" }]), f, {
      cancelled: () => done++ > 0,
    });
    expect(report.items[0].state).toBe("ready");
    expect(report.items[1].state).toBe("cancelled");
    expect(report.state).toBe("partially_succeeded");
    expect(f.calls).not.toContain("create:b");
  });

  it("never abandons a row halfway: cancelling is checked between rows, not inside one", async () => {
    const f = fakeEffects();
    await run(planFor([{ clientItemId: "a" }]), f, { cancelled: () => true });
    expect(f.calls).toEqual([]);
  });
});

describe("retrying", () => {
  it("runs only the rows asked for, so what already exists is not built twice", async () => {
    const f = fakeEffects();
    const report = await run(planFor([{ clientItemId: "a" }, { clientItemId: "b" }]), f, {
      only: ["b"],
    });
    expect(f.calls.filter((c) => c.startsWith("create:"))).toEqual(["create:b"]);
    expect(report.items.find((i) => i.clientItemId === "a")?.state).toBe("cancelled");
  });
});

describe("cleaning up afterwards, by hand", () => {
  /** A batch whose only row failed at the group step with the folder stuck. */
  const stuck = async (fail: Record<string, string>, moved: string[] = []) => {
    const f = fakeEffects({ fail: { "group:a": "erro", ...fail }, moved: new Set(moved) });
    const report = await run(planFor([{ clientItemId: "a" }]), f);
    expect(report.items[0].state).toBe("cleanup_required");
    f.calls.length = 0;
    return { f, report };
  };

  it("tries again exactly what failed the first time, and nothing else", async () => {
    const { f, report } = await stuck({ "rm:C:/proj/.yard/floors/a": "arquivo em uso" });
    f.fail = {};
    const after = await cleanupItems(report.journal, ["a"], f);
    expect(f.calls).toEqual(["rm:C:/proj/.yard/floors/a", "branch-rm:yard/a"]);
    expect(after.items[0].state).toBe("rolled_back");
  });

  it("still refuses to delete a branch that has work on it, however many times it is asked", async () => {
    const { f, report } = await stuck({}, ["yard/a"]);
    const after = await cleanupItems(report.journal, ["a"], f);
    expect(after.items[0].state).toBe("cleanup_required");
  });

  it("leaves the rows nobody asked about alone", async () => {
    const { f, report } = await stuck({ "rm:C:/proj/.yard/floors/a": "arquivo em uso" });
    const after = await cleanupItems(report.journal, [], f);
    expect(f.calls).toEqual([]);
    expect(after.items).toEqual([]);
  });
});
