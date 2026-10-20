/** Task requests and reports are visible only to the terminals explicitly assigned to the work. */
import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ taskGet: vi.fn(), taskList: vi.fn(), taskSubmit: vi.fn(), taskDeliveries: vi.fn(), writePref: vi.fn(async () => {}) }));
vi.mock("./ipc", () => ({ ipc: native }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: vi.fn() }));
import { handleBridgeRequest } from "./bridge";
import { useProjects } from "../stores/projectsStore";

beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
  vi.clearAllMocks();
  useProjects.setState({ projects: [], groups: [], terminals: [], activeGroupId: null, activeProjectId: null });
});

function caller() {
  const groupId = useProjects.getState().addBoard("Task workspace");
  return useProjects.getState().addTerminal({ groupId, title: "Task agent", kind: "agent", program: "agent.exe", cwd: "C:/project" });
}

it("returns previous reports only to a terminal assigned to that task", async () => {
  const id = caller();
  native.taskGet.mockResolvedValue({ id: "task-1", links: { terminalIds: [id] } });
  const reports = [{ taskId: "task-1", revision: 4, delivery: { summary: "Earlier evidence", artifacts: ["first-proof.txt"], checks: [] }, criteria: [], at: 4000, recovered: false }];
  native.taskDeliveries.mockResolvedValue(reports);
  const result = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: id, argv: ["task", "history", "task-1"] });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output)).toEqual(reports);
  const denied = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: caller(), argv: ["task", "history", "task-1"] });
  expect(denied.code).toBe(1);
  expect(denied.output).not.toContain("Earlier evidence");
});

it("keeps prior participants from submitting a report for another current executor", async () => {
  const former = caller();
  const current = caller();
  const task = { id: "task-1", revision: 5, links: { terminalIds: [former, current], executorTerminalId: current } };
  native.taskGet.mockResolvedValue(task);
  const submission = { delivery: { summary: "Current executor report", artifacts: [], checks: [] }, evidence: {} };
  native.taskSubmit.mockResolvedValue({ ...task, status: "in_review", delivery: submission.delivery });
  const request = { v: 1, cwd: "C:/project", terminal: former, argv: ["task", "submit", task.id, "--stdin"], stdin: JSON.stringify(submission) };
  const denied = await handleBridgeRequest(request);
  expect(denied.code).toBe(1);
  const accepted = await handleBridgeRequest({ ...request, terminal: current });
  expect(accepted.code).toBe(0);
  expect(JSON.parse(accepted.output).delivery.summary).toBe("Current executor report");
});

it("returns the work request and acceptance criteria to its assigned terminal", async () => {
  const id = caller();
  native.taskGet.mockResolvedValue({ id: "task-1", title: "Review", request: "Verify API compatibility", criteria: [{ id: "criterion-1", text: "Existing clients work", evidence: [] }], links: { terminalIds: [id], projectId: null }, revision: 1, status: "draft" });
  const result = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: id, argv: ["task", "show", "task-1"] });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output).request).toBe("Verify API compatibility");
  expect(JSON.parse(result.output).criteria[0].text).toBe("Existing clients work");
  const outsider = caller();
  const denied = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: outsider, argv: ["task", "show", "task-1"] });
  expect(denied.code).toBe(1);
  expect(denied.output).not.toContain("Verify API compatibility");
});

it("records submitted evidence for assigned work without approving it", async () => {
  const id = caller();
  const task = { id: "task-1", title: "Review", request: "Verify API", criteria: [{ id: "criterion-1", text: "Existing clients work", evidence: [] }], links: { terminalIds: [id], projectId: null }, revision: 3, status: "running" };
  const submission = { delivery: { summary: "Verified", checks: [{ name: "Regression suite", passed: true, evidence: "test-result.txt" }], artifacts: [] }, evidence: { "criterion-1": ["test-result.txt"] } };
  native.taskGet.mockResolvedValue(task);
  native.taskSubmit.mockResolvedValue({ ...task, status: "in_review", revision: 4, delivery: submission.delivery });
  const result = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: id, argv: ["task", "submit", task.id, "--stdin"], stdin: JSON.stringify(submission) });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output).status).toBe("in_review");
  expect(native.taskSubmit.mock.calls[0][2]).toEqual(submission);
});

it("forwards the explicit execution attempt without replacing it with the task's latest attempt", async () => {
  const id = caller();
  const task = { id: "task-1", revision: 5, status: "running", links: { terminalIds: [id], executorTerminalId: id, queueItemId: "new-attempt" } };
  const submission = { delivery: { summary: "Original attempt report", checks: [], artifacts: [] }, evidence: {} };
  native.taskGet.mockResolvedValue(task);
  native.taskSubmit.mockImplementation(async (_id, _revision, report) => {
    if (report.attemptId !== "new-attempt") throw new Error("Delivery must identify the current execution attempt");
    return { ...task, status: "in_review", delivery: report.delivery };
  });
  const request = { v: 1, cwd: "C:/project", terminal: id, argv: ["task", "submit", task.id, "--attempt", "old-attempt", "--stdin"], stdin: JSON.stringify(submission) };
  expect((await handleBridgeRequest(request)).code).toBe(1);
  expect(native.taskSubmit.mock.calls[0][2]).toEqual({ ...submission, attemptId: "old-attempt" });
  const current = await handleBridgeRequest({ ...request, argv: ["task", "submit", task.id, "--attempt", "new-attempt", "--stdin"] });
  expect(current.code).toBe(0);
  expect(JSON.parse(current.output).status).toBe("in_review");
});
