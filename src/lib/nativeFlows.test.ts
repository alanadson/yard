/** Native flow acceptance must reach durable storage before the interface reports a running pipeline. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ start: vi.fn(), snapshot: vi.fn(), resume: vi.fn(), dismiss: vi.fn(), input: vi.fn(async () => undefined), read: vi.fn(async () => ({})), write: vi.fn(async () => undefined) }));
vi.mock("./ipc", () => ({ ipc: { flowStart: boundary.start, flowSnapshot: boundary.snapshot, flowResume: boundary.resume, flowDismiss: boundary.dismiss, writePty: boundary.input, readPrefs: boundary.read, writePref: boundary.write } }));

import { canResumeFlow, flowErrorText, flowRunStageLabel, resumeFlow, startFlow } from "./flowRun";
import { setActiveLang } from "./i18n";
import { confirmationSnapshot, resetConfirmationsForTests, settleConfirmation } from "./confirmation";
import { useFlows, type FlowRun } from "../stores/flowStore";
import { useProjects } from "../stores/projectsStore";
import { useTerminals } from "../stores/terminalsStore";
import { setPrefsTransport } from "./prefs";
import { forgetTyped, interceptFlowInput } from "./flowIntercept";
import { useUI } from "../stores/uiStore";

it("explains that a changed task request must be refreshed before a pipeline can start", () => {
  expect(flowErrorText("FLOW_TASK_REQUEST_CHANGED")).toBe("O pedido da tarefa mudou. Atualize o painel antes de iniciar o fluxo.");
});

it("sends a task's revision with its pipeline acceptance request", async () => {
  useProjects.setState({ terminals: [{ id: "executor", groupId: "group", kind: "agent", program: "agent", args: [], cwd: "C:/project", surface: "canvas", slot: 0, sort: 0, alive: true, createdAt: 1000 }] });
  useTerminals.setState({ byId: { executor: { state: "running", pid: 42 } as never } });
  const definition = { id: "pipeline", type: "flow" as const, name: "Pipeline", stages: [{ prompt: "Plan the change" }], x: 0, y: 0, w: 200, h: 100, color: "#fff" };
  boundary.start.mockResolvedValue({ owner: "native", ...definition, flowId: definition.id, groupId: "group", terminalId: "executor", stages: [{ label: "Plan", status: "pending" }], finishedAt: null } as unknown as FlowRun);
  await startFlow("group", definition, "Original request", { terminalId: "executor", work: { id: "task", revision: 7 } });
  expect(boundary.start.mock.calls[0][6]).toEqual({ id: "task", revision: 7 });
});

let restorePrefs = () => {};
beforeEach(() => { restorePrefs = setPrefsTransport({ nativeScheduler: true, readPrefs: boundary.read, writePref: boundary.write }); });
afterEach(() => { useFlows.setState({ runs: {}, marks: {} }); vi.clearAllMocks(); restorePrefs(); resetConfirmationsForTests(); setActiveLang("pt-BR"); });

it("shows a native flow only after the backend acknowledges its original request", async () => {
  let acknowledge!: (run: FlowRun) => void;
  boundary.start.mockReturnValue(new Promise<FlowRun>((resolve) => { acknowledge = resolve; }));
  useProjects.setState({ terminals: [{ id: "executor", groupId: "group", kind: "agent", program: "agent", args: [], cwd: "C:/project", surface: "canvas", slot: 0, sort: 0, alive: true, createdAt: 1000 }] });
  useTerminals.setState({ byId: { executor: { state: "running", pid: 42 } as never } });
  const definition = { id: "pipeline", type: "flow" as const, name: "Pipeline", stages: [{ prompt: "Plan the change" }], x: 0, y: 0, w: 200, h: 100, color: "#fff" };
  const accepted = startFlow("group", definition, "Original request", { terminalId: "executor" });
  expect(useFlows.getState().runs).toEqual({});
  const run = { owner: "native", flowId: "pipeline", groupId: "group", terminalId: "executor", name: "Pipeline", task: "Original request", stages: [{ label: "Plan", status: "pending" }], current: 0, brief: "", startedAt: 1000, stageStartedAt: 1000, finishedAt: null, error: null, cancelled: false, cancelRequested: false } as FlowRun;
  acknowledge(run);
  expect((await accepted).ok).toBe(true);
  expect(useFlows.getState().runs.pipeline).toEqual(run);
});

it("restores an active backend flow after a renderer reload without marking its stage interrupted", async () => {
  const run = { owner: "native", flowId: "pipeline", groupId: "group", terminalId: "executor", name: "Pipeline", task: "Original request", stages: [{ label: "Plan", status: "working" }], current: 0, brief: "Preserved stage", startedAt: 1000, stageStartedAt: 2000, finishedAt: null, error: null, cancelled: false, cancelRequested: false } as FlowRun;
  boundary.snapshot.mockResolvedValue([run]);
  await useFlows.getState().restore({});
  expect(useFlows.getState().runs.pipeline).toEqual(run);
  expect(useFlows.getState().marks.executor.status).toBe("working");
});

it("does not let an older native snapshot replace a newly acknowledged execution", async () => {
  let resolveSnapshot!: (runs: FlowRun[]) => void;
  boundary.snapshot.mockReturnValue(new Promise<FlowRun[]>((resolve) => { resolveSnapshot = resolve; }));
  const refreshing = useFlows.getState().refreshNative();
  const run = { owner: "native", flowId: "pipeline", groupId: "group", terminalId: "executor", name: "Pipeline", task: "New request", stages: [{ label: "Plan", status: "pending" }], current: 0, brief: "", startedAt: 3000, stageStartedAt: 3000, finishedAt: null, error: null, cancelled: false, cancelRequested: false } as FlowRun;
  useFlows.getState().begin(run);
  resolveSnapshot([]);
  await refreshing;
  expect(useFlows.getState().runs.pipeline).toEqual(run);
});

it("keeps an interrupted stage stopped when its reviewed resend is declined", async () => {
  const run = { owner: "native", flowId: "pipeline", groupId: "group", terminalId: "executor", name: "Pipeline", phase: "interrupted", attempt: 3, stages: [{ label: "Verify", status: "error" }], finishedAt: 2000, error: "FLOW_DELIVERY_UNCERTAIN" } as FlowRun;
  useFlows.getState().begin(run);
  const review = resumeFlow(run);
  expect(confirmationSnapshot()?.message).toContain("repetir trabalho");
  settleConfirmation(false);
  await review;
  expect(useFlows.getState().runs.pipeline).toEqual(run);
  expect(boundary.resume).not.toHaveBeenCalled();
});

it("offers reviewed resumption only for an interrupted native execution", () => {
  const run = { owner: "native", phase: "interrupted" } as FlowRun;
  expect(canResumeFlow(run)).toBe(true);
  expect(canResumeFlow({ ...run, phase: "done" })).toBe(false);
  expect(canResumeFlow({ ...run, owner: undefined })).toBe(false);
});

it("does not resurrect a dismissed native result when the next snapshot arrives", async () => {
  const run = { owner: "native", flowId: "pipeline", groupId: "group", terminalId: "executor", name: "Pipeline", task: "Original request", stages: [{ label: "Plan", status: "done" }], current: 1, brief: "", startedAt: 1000, stageStartedAt: 1000, finishedAt: 2000, error: null, cancelled: false, cancelRequested: false, phase: "done", attempt: 2 } as FlowRun;
  let backend = [run];
  boundary.snapshot.mockImplementation(async () => backend);
  boundary.dismiss.mockImplementation(async () => { backend = []; });
  useFlows.getState().begin(run);
  await useFlows.getState().clear(run.flowId);
  await useFlows.getState().refreshNative();
  expect(useFlows.getState().runs.pipeline).toBeUndefined();
});

it("does not submit an extra Enter when native flow acceptance is unconfirmed", async () => {
  let reject!: (error: Error) => void;
  boundary.start.mockReturnValue(new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
  useFlows.setState({ runs: {}, marks: {} });
  useUI.setState({ toasts: [] });
  forgetTyped("executor");
  // `trigger: true`: a wire alone no longer arms the Enter interception, only
  // a trigger the user switched on does (`armsEnter`).
  const canvas = { items: [{ id: "pipeline", type: "flow", name: "Pipeline", stages: [{ prompt: "Plan the change" }], trigger: true, x: 0, y: 0, w: 240, h: 200, color: "#ffffff" }, { id: "wire", type: "connection", from: "pipeline", to: "executor", color: "#ffffff" }] };
  useProjects.setState({ groups: [{ id: "group", projectId: null, name: "Board", layoutJson: JSON.stringify({ surface: "canvas", canvas }), sort: 0, suspended: false }],
    terminals: [{ id: "executor", groupId: "group", kind: "agent", program: "agent", args: [], cwd: "C:/project", surface: "canvas", slot: 0, sort: 0, alive: true, createdAt: 1000 }] });
  useTerminals.setState({ byId: { executor: { state: "running", pid: 42 } as never } });
  interceptFlowInput("executor", "Original request");
  expect(interceptFlowInput("executor", "\r")).toBe(true);
  reject(new Error("Lost acknowledgment"));
  await vi.waitFor(() => expect(useUI.getState().toasts.some((toast) => toast.kind === "error")).toBe(true));
  expect(boundary.input).not.toHaveBeenCalled();
});

it("explains an unconfirmed stage delivery without exposing its protocol code", () => {
  expect(flowErrorText("FLOW_DELIVERY_UNCERTAIN")).toBe("A entrega da etapa ficou incerta. Confira o terminal antes de retomar.");
});

it("displays a backend-generated stage label in the selected interface language", () => {
  setActiveLang("en");
  const run = { owner: "native", stages: [{ label: "Etapa 1", status: "pending" }], definition: [{ prompt: "Plan the change" }] } as FlowRun;
  expect(flowRunStageLabel(run, 0)).toBe("Stage 1");
});
