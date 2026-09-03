/**
 * A worker is a front opened for one task with one agent in it. The CLI
 * treats it as one object (`yard worker …`) instead of a front plus a
 * terminal plus a branch the caller has to stitch together. These rules
 * decide which fronts count, which terminal speaks for the worker, what
 * state it is in and how it is found by name; the effects (git, PTY) stay
 * in `bridge.ts`.
 */
import { describe, expect, it } from "vitest";

import type { FloorMeta } from "./floors";
import type { LandPreview } from "./ipc";
import type { TerminalRuntime } from "../stores/terminalsStore";
import {
  findWorker,
  formatWorkerList,
  formatWorkerReview,
  isWorkerFloor,
  keptFloor,
  workerRows,
  workerStateOf,
  workerTerminal,
} from "./workerRuns";

const task = { id: "t1", prompt: "fix the login", createdAt: 1 };

function rt(patch: Partial<TerminalRuntime>): TerminalRuntime {
  return {
    state: "running",
    pid: 1,
    exit: null,
    error: null,
    unread: false,
    finished: false,
    finishedAt: 0,
    blocked: false,
    blockedAsk: null,
    permission: false,
    rssMb: 0,
    cpu: 0,
    ...patch,
  };
}

describe("isWorkerFloor", () => {
  it("an isolated front with a task is a worker; without either it is not", () => {
    expect(isWorkerFloor({ kind: "isolated", branch: "w/a", task })).toBe(true);
    expect(isWorkerFloor({ kind: "isolated", branch: "w/a" })).toBe(false);
    expect(isWorkerFloor({ kind: "ground", task })).toBe(false);
    expect(isWorkerFloor(undefined)).toBe(false);
  });
});

describe("workerStateOf", () => {
  it("reads the runtime mirror in the order a human would ask about it", () => {
    expect(workerStateOf(undefined)).toBe("stopped");
    expect(workerStateOf(rt({ state: "starting" }))).toBe("starting");
    expect(workerStateOf(rt({}))).toBe("working");
    expect(workerStateOf(rt({ finished: true }))).toBe("done");
    expect(workerStateOf(rt({ finished: true, blocked: true }))).toBe("blocked");
    expect(workerStateOf(rt({ finished: true, blocked: true, permission: true }))).toBe("permission");
    expect(workerStateOf(rt({ state: "exited", pid: null }))).toBe("exited");
    expect(workerStateOf(rt({ state: "error", pid: null }))).toBe("exited");
  });
});

describe("workerTerminal", () => {
  it("the agent card speaks for the worker, whatever else is on the front", () => {
    const shell = { id: "s", kind: "shell" };
    const agent = { id: "a", kind: "agent" };
    expect(workerTerminal([shell, agent])).toBe(agent);
    expect(workerTerminal([shell])).toBe(shell);
    expect(workerTerminal([])).toBeUndefined();
  });
});

describe("workerRows", () => {
  const floors: Record<string, FloorMeta | undefined> = {
    g1: { kind: "isolated", branch: "w/login", worktreePath: "C:\w\login", task, agentId: "claude" },
    g2: { kind: "isolated", branch: "feat/x" },
    g0: undefined,
  };
  const rows = workerRows({
    groups: [
      { id: "g0", name: "chão" },
      { id: "g1", name: "Login" },
      { id: "g2", name: "Feature" },
    ],
    floorOf: (id) => floors[id],
    terminalsOf: (id) => (id === "g1" ? [{ id: "t-login", kind: "agent" }] : []),
    runtimeOf: (id) => (id === "t-login" ? rt({ finished: true }) : undefined),
  });

  it("lists only the worker fronts, with the state of their agent card", () => {
    expect(rows.map((r) => r.name)).toEqual(["Login"]);
    expect(rows[0]).toMatchObject({
      groupId: "g1",
      agentId: "claude",
      branch: "w/login",
      worktreePath: "C:\w\login",
      terminalId: "t-login",
      state: "done",
      task,
    });
  });

  it("a worker whose card is gone is stopped, not missing from the list", () => {
    const orphan = workerRows({
      groups: [{ id: "g1", name: "Login" }],
      floorOf: () => floors.g1,
      terminalsOf: () => [],
      runtimeOf: () => undefined,
    });
    expect(orphan[0]).toMatchObject({ terminalId: null, state: "stopped" });
  });
});

describe("findWorker", () => {
  const rows = workerRows({
    groups: [
      { id: "grp-login-1", name: "Login" },
      { id: "grp-logout-2", name: "Logout" },
      { id: "grp-search-3", name: "Busca" },
    ],
    floorOf: (id) => ({ kind: "isolated", branch: id, task }),
    terminalsOf: () => [],
    runtimeOf: () => undefined,
  });

  it("the exact name wins, case-insensitively", () => {
    expect(findWorker(rows, "login")?.groupId).toBe("grp-login-1");
  });

  it("the group id is an address too, for callers that kept it from create", () => {
    expect(findWorker(rows, "grp-search-3")?.name).toBe("Busca");
  });

  it("a prefix only finds a worker when it names exactly one", () => {
    expect(findWorker(rows, "bus")?.name).toBe("Busca");
    expect(findWorker(rows, "log")).toBeUndefined();
    expect(findWorker(rows, "")).toBeUndefined();
  });
});

describe("keptFloor", () => {
  it("keeping a worker turns it into a plain front: the task goes, the branch stays", () => {
    const floor: FloorMeta = {
      kind: "isolated",
      branch: "w/login",
      worktreePath: "C:\w\login",
      task,
      agentId: "claude",
      color: "#ff0000",
    };
    expect(keptFloor(floor)).toEqual({
      kind: "isolated",
      branch: "w/login",
      worktreePath: "C:\w\login",
      color: "#ff0000",
    });
  });
});

describe("formatWorkerList", () => {
  it("says so when there is none, and one line per worker otherwise", () => {
    expect(formatWorkerList([], "Yard")).toContain("Nenhum worker");
    const rows = workerRows({
      groups: [{ id: "g1", name: "Login" }],
      floorOf: () => ({ kind: "isolated", branch: "w/login", task, agentId: "claude" }),
      terminalsOf: () => [{ id: "t", kind: "agent" }],
      runtimeOf: () => rt({ finished: true, blocked: true, blockedAsk: "Overwrite?" }),
    });
    const out = formatWorkerList(rows, "Yard");
    expect(out).toContain('"Login"');
    expect(out).toContain("[blocked]");
    expect(out).toContain("claude");
    expect(out).toContain("w/login");
    expect(out).toContain("Overwrite?");
  });
});

describe("formatWorkerReview", () => {
  const base: LandPreview = {
    groundBranch: "main",
    floorBranch: "w/login",
    clean: true,
    alreadyMerged: false,
    groundDirty: false,
    floorDirty: false,
    files: [
      { path: "src/a.ts", origPath: null, status: "modified", additions: 3, deletions: 1 },
      { path: "src/b.ts", origPath: null, status: "added", additions: 10, deletions: 0 },
    ],
    additions: 13,
    deletions: 1,
    conflictPaths: [],
  };

  it("a clean review lists every file with its counts and the total", () => {
    const out = formatWorkerReview(base);
    expect(out).toContain("w/login");
    expect(out).toContain("main");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("+3");
    expect(out).toContain("src/b.ts");
    expect(out).toContain("2 arquivo(s)");
  });

  it("conflicts come first, because they are what stops apply", () => {
    const out = formatWorkerReview({ ...base, clean: false, conflictPaths: ["src/a.ts"] });
    expect(out.split("\n")[1]).toContain("conflito");
    expect(out).toContain("src/a.ts");
  });

  it("already on the ground means there is nothing to apply", () => {
    expect(formatWorkerReview({ ...base, alreadyMerged: true, files: [] })).toContain("já no chão");
  });
});
