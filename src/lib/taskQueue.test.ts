/** A native task enqueue must preserve queue edits made while its acknowledgement is in flight. */
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ taskEnqueue: vi.fn(), taskGet: vi.fn(), taskRetryDelivery: vi.fn(), taskTransition: vi.fn(), taskRequestReview: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: native }));
import { cancelTaskPrompt, clearTaskPrompts, queueTask, retryTaskPrompt, queueTaskReview } from "./taskQueue";
import { KV_QUEUE, useQueue } from "../stores/queueStore";
import { setPrefsTransport } from "./prefs";
import type { TaskQueueResult } from "./work";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; vi.useRealTimers(); useQueue.setState({ items: [] }); });

it("adds an acknowledged review without dropping independently queued work", async () => {
  const saved: Record<string, string> = {};
  restore = setPrefsTransport({ readPrefs: async () => saved, writePref: async (key, value) => { saved[key] = value; } });
  const other = { id: "other", terminalId: "other-agent", text: "Other work", source: "user" as const, at: 1000 };
  const review = { id: "review-queue", terminalId: "reviewer", taskId: "review", text: "Review evidence", source: "user" as const, at: 2000 };
  useQueue.setState({ items: [other] });
  native.taskRequestReview.mockResolvedValue({ task: { id: "review" }, items: [other, review] });
  await queueTaskReview({ taskId: "original", revision: 4, reviewId: "review", terminalId: "reviewer", queueId: "review-queue", title: "Review" });
  expect(useQueue.getState().items).toEqual([other, review]);
  expect(JSON.parse(saved[KV_QUEUE])).toEqual([other, review]);
});

it("preserves a second native task while synchronizing the acknowledged task enqueue", async () => {
  useQueue.setState({ items: [] });
  const linked = { id: "linked", terminalId: "executor", taskId: "task-1", text: "First work", source: "user" as const, at: 1000 };
  const other = { ...linked, id: "other", taskId: "task-2", text: "Second work" };
  let received: unknown;
  restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
    patchQueue: async (before, after) => { received = { before, after }; return [...after, other]; } });
  native.taskEnqueue.mockResolvedValue({ task: { id: "task-1" }, items: [linked] });
  await queueTask("task-1", 0, "executor", linked.id);
  expect(useQueue.getState().items).toEqual([linked, other]);
  expect(received).toEqual({ before: [linked], after: [linked] });
});

it("does not clear a newer native reservation when an already queued task is acknowledged again", async () => {
  const pending = { id: "linked", terminalId: "executor", taskId: "task-1", text: "First work", source: "user" as const, at: 1000 };
  const reserved = { ...pending, delivery: { status: "sending" as const, attemptedAt: 2000 } };
  useQueue.setState({ items: [pending] });
  let received: unknown;
  restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
    patchQueue: async (before, after) => { received = { before, after }; return [...after]; } });
  native.taskEnqueue.mockResolvedValue({ task: { id: "task-1" }, items: [reserved] });
  await queueTask("task-1", 0, "executor", pending.id);
  expect(useQueue.getState().items).toEqual([reserved]);
  expect(received).toEqual({ before: [reserved], after: [reserved] });
});

it("clears only the selected terminal and retains linked work whose cancellation failed", async () => {
  const saved: Record<string, string> = {};
  restore = setPrefsTransport({ readPrefs: async () => saved, writePref: async (key, value) => { saved[key] = value; } });
  const failed = { id: "failed", terminalId: "executor", taskId: "task-1", text: "Durable work", source: "user" as const, at: 1000 };
  const plain = { id: "plain", terminalId: "executor", text: "Plain prompt", source: "user" as const, at: 1000 };
  const elsewhere = { ...plain, id: "elsewhere", terminalId: "other-executor" };
  useQueue.setState({ items: [plain, failed, elsewhere] });
  native.taskGet.mockResolvedValue({ id: "task-1", status: "queued", revision: 2 });
  native.taskTransition.mockRejectedValue(new Error("Task changed"));
  await expect(clearTaskPrompts("executor")).rejects.toThrow("Task changed");
  expect(useQueue.getState().items).toEqual([failed, elsewhere]);
  expect(JSON.parse(saved[KV_QUEUE])).toEqual([failed, elsewhere]);
});

it("keeps a linked prompt until cancellation of its queued task is acknowledged", async () => {
  const saved: Record<string, string> = {};
  restore = setPrefsTransport({ readPrefs: async () => saved, writePref: async (key, value) => { saved[key] = value; } });
  const item = { id: "waiting", terminalId: "executor", taskId: "task-1", text: "Original work", source: "user" as const, at: 1000 };
  const unrelated = { ...item, id: "other", taskId: "task-2" };
  useQueue.setState({ items: [item, unrelated] });
  const task = { id: "task-1", status: "queued", revision: 2 };
  native.taskGet.mockResolvedValue(task);
  let acknowledge!: (value: unknown) => void;
  native.taskTransition.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
  const pending = cancelTaskPrompt(item.id);
  await vi.waitFor(() => expect(native.taskTransition).toHaveBeenCalledWith(task.id, task.revision, "cancelled"));
  expect(useQueue.getState().items).toEqual([item, unrelated]);
  acknowledge({ ...task, status: "cancelled", revision: 3 });
  await pending;
  expect(useQueue.getState().items).toEqual([unrelated]);
  expect(JSON.parse(saved[KV_QUEUE])).toEqual([unrelated]);
});

it("keeps an uncertain task prompt until native retry acknowledges its fresh queue identity", async () => {
  const saved: Record<string, string> = {};
  restore = setPrefsTransport({ readPrefs: async () => saved, writePref: async (key, value) => { saved[key] = value; } });
  const old = { id: "old-attempt", terminalId: "executor", taskId: "task-1", text: "Original work", source: "user" as const, at: 1000,
    delivery: { status: "uncertain" as const, attemptedAt: 2000 } };
  const replacement = { id: "new-attempt", terminalId: "executor", taskId: "task-1", text: "Original work", source: "user" as const, at: 3000 };
  useQueue.setState({ items: [old] });
  const task = { id: "task-1", title: "Verify", request: "Original work", status: "running", criteria: [], links: { projectId: null, terminalIds: ["executor"], executorTerminalId: "executor", queueItemId: old.id }, delivery: null, revision: 3, createdAt: 1000, updatedAt: 2000 };
  native.taskGet.mockResolvedValue(task);
  let acknowledge!: (result: TaskQueueResult) => void;
  native.taskRetryDelivery.mockReturnValue(new Promise<TaskQueueResult>((resolve) => { acknowledge = resolve; }));
  const pending = retryTaskPrompt(old.id, replacement.id);
  await vi.waitFor(() => expect(native.taskRetryDelivery).toHaveBeenCalledWith(task.id, task.revision, old.terminalId, old.id, replacement.id));
  expect(useQueue.getState().items).toEqual([old]);
  acknowledge({ task: { ...task, status: "queued", revision: 4, links: { ...task.links, queueItemId: replacement.id } }, items: [replacement] });
  await pending;
  expect(useQueue.getState().items).toEqual([replacement]);
  expect(JSON.parse(saved[KV_QUEUE])).toEqual([replacement]);
});

it("replaces the interrupted task prompt after native acknowledgement without removing other queued work", async () => {
  const saved: Record<string, string> = {};
  restore = setPrefsTransport({ readPrefs: async () => saved, writePref: async (key, value) => { saved[key] = value; } });
  const old = { id: "old-queue", terminalId: "old-agent", taskId: "task-1", text: "Interrupted prompt", source: "user" as const, at: 1000,
    delivery: { status: "uncertain" as const, attemptedAt: 2000 } };
  const unrelated = { id: "other-queue", terminalId: "other-agent", taskId: "task-2", text: "Other work", source: "user" as const, at: 1000 };
  const replacement = { id: "new-queue", terminalId: "new-agent", taskId: "task-1", text: "Resume the original request", source: "user" as const, at: 3000 };
  useQueue.setState({ items: [old, unrelated] });
  const task = { id: "task-1", title: "Verify", request: "request", status: "queued", criteria: [], links: { projectId: null, terminalIds: ["old-agent", "new-agent"], executorTerminalId: "new-agent", queueItemId: replacement.id }, delivery: null, revision: 6, createdAt: 1000, updatedAt: 3000 };
  native.taskEnqueue.mockResolvedValue({ task, items: [unrelated, replacement] });
  await queueTask(task.id, 5, replacement.terminalId, replacement.id);
  expect(useQueue.getState().items).toEqual([unrelated, replacement]);
  expect(JSON.parse(saved[KV_QUEUE])).toEqual([unrelated, replacement]);
});

it("keeps newly queued prompts and cancellations while native task queueing is acknowledged", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const saved: Record<string, string> = {};
  restore = setPrefsTransport({ readPrefs: async () => saved, writePref: async (key, value) => { saved[key] = value; } });
  const old = { id: "old", terminalId: "agent", text: "Cancelled prompt", source: "user" as const, at: 1_000 };
  useQueue.setState({ items: [old] });
  let acknowledge!: (result: TaskQueueResult) => void;
  native.taskEnqueue.mockReturnValue(new Promise<TaskQueueResult>((resolve) => { acknowledge = resolve; }));
  const pending = queueTask("task-1", 1, "agent", "task-queue");
  await useQueue.getState().cancel(old.id);
  await useQueue.getState().enqueue("agent", "New local prompt", "user");
  const task = { id: "task-1", title: "Verify", request: "request", status: "queued", criteria: [], links: { projectId: null, terminalIds: ["agent"], queueItemId: "task-queue" }, delivery: null, revision: 2, createdAt: 1_000, updatedAt: 2_000 };
  acknowledge({ task, items: [old, { ...old, id: "task-queue", taskId: task.id, text: "Durable task prompt" }] });
  expect(await pending).toEqual(task);
  expect(useQueue.getState().listFor("agent").map((item) => item.text)).toEqual(["New local prompt", "Durable task prompt"]);
  expect(JSON.parse(saved[KV_QUEUE])).toEqual(useQueue.getState().items);
});
