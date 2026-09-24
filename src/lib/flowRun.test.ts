/**
 * The engine's first promise is that a blocked or busy agent pauses the flow
 * and never fails it: a CLI chewing on a long turn is not a broken pipeline,
 * and the only terminal that ends a stage before it starts is one that died.
 * The clock is faked so ten minutes of polling cost nothing.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sendabilityMock = vi.hoisted(() => vi.fn());
vi.mock("./sendable", () => ({ sendability: (...args: unknown[]) => sendabilityMock(...args) }));
vi.mock("./ipc", () => ({
  ipc: {
    ptyProbe: vi.fn(async () => ({ alive: true, totalBytes: 0 })),
    ptyReadSince: vi.fn(async () => ({ data: "" })),
    readPrefs: vi.fn(async () => ({})),
    writePref: vi.fn(async () => undefined),
    writePrefs: vi.fn(async () => undefined),
  },
}));
vi.mock("./inject", () => ({ injectPrompt: vi.fn(async () => undefined) }));
vi.mock("./notifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("./log", () => ({
  uiLog: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import type { FlowItem } from "./flow";
import { startFlow } from "./flowRun";
import { useFlows } from "../stores/flowStore";
import { useProjects } from "../stores/projectsStore";
import { useTerminals, type TerminalRuntime } from "../stores/terminalsStore";

const RUNTIME: TerminalRuntime = {
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
};

const flow: FlowItem = {
  id: "flow",
  type: "flow",
  color: "#f5f5f5",
  x: 0,
  y: 0,
  w: 200,
  h: 100,
  name: "Pipeline",
  stages: [{ prompt: "Revise como QA" }],
};

beforeEach(() => {
  vi.useFakeTimers();
  sendabilityMock.mockReset();
  useFlows.setState({ runs: {}, marks: {} });
  useProjects.setState({
    loaded: false,
    projects: [],
    groups: [{ id: "g1", projectId: null, name: "Board", layoutJson: "{}", suspended: false, sort: 0 }],
    terminals: [{ id: "t1", groupId: "g1", slot: 0, kind: "agent", title: "claude", program: "claude", args: [], cwd: "C:/proj", sort: 0, alive: true, createdAt: 0 }],
    activeProjectId: null,
    activeGroupId: "g1",
  });
  useTerminals.setState({ byId: { t1: { ...RUNTIME } } });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The regression: the doc said busy re-arms the deadline like blocked does,
 * the code re-armed only on blocked, and a CLI busy for ten minutes failed
 * the stage with "ocupada por muito tempo".
 */
it("keeps waiting on a CLI that stays busy past the ready timeout; only its death ends the turn", async () => {
  const start = Date.now();
  sendabilityMock.mockImplementation(() =>
    Date.now() - start < 15 * 60_000
      ? { ok: false, reason: "busy" }
      : { ok: false, reason: "dead", message: "o terminal morreu" },
  );

  const started = startFlow("g1", flow, "Tarefa", { terminalId: "t1" });
  expect(started.ok).toBe(true);

  await vi.advanceTimersByTimeAsync(12 * 60_000);
  expect(useFlows.getState().runs.flow.finishedAt).toBeNull();

  await vi.advanceTimersByTimeAsync(4 * 60_000);
  const run = useFlows.getState().runs.flow;
  expect(run.error).toBe("o terminal morreu");
  expect(run.error).not.toContain("ocupada por muito tempo");
});
