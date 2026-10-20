/** A failed PTY delivery must leave the user's prompt recoverable without submitting it twice. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deliverQueueItem } from "./queueDelivery";
import * as deliveryRules from "./queueDelivery";
import { dueItems, type QueueItem } from "./queue";
import { KV_QUEUE, useQueue } from "../stores/queueStore";
import { useProjects } from "../stores/projectsStore";
import { setPrefsTransport } from "./prefs";
import * as queueTransport from "./prefs";

const api = vi.hoisted(() => ({ write: vi.fn(), claim: vi.fn(), saved: {} as Record<string, string> }));
vi.mock("./ipc", () => ({ ipc: { writePty: api.write, taskClaim: api.claim } }));
let restoreTransport: (() => void) | undefined;

afterEach(() => { vi.useRealTimers(); restoreTransport?.(); restoreTransport = undefined; });

beforeEach(() => {
  vi.resetAllMocks();
  api.saved = {};
  restoreTransport?.();
  restoreTransport = setPrefsTransport({
    readPrefs: async () => api.saved,
    writePref: async (key, value) => { api.saved[key] = value; },
  });
  useQueue.setState({ items: [] });
  useProjects.setState({ terminals: [{ id: "agent", groupId: "group", cwd: "C:/repo", program: "claude", args: [], kind: "agent", slot: 0, sort: 0, alive: true, createdAt: 1_000 }] });
});

it("hands the complete queue delivery and acknowledgment to one native operation", async () => {
  const item: QueueItem = { id: "native-request", terminalId: "agent", text: "Native durable delivery", at: 1000, source: "bridge" };
  useQueue.setState({ items: [item] });
  let finish!: (result: { status: "delivered"; items: QueueItem[]; error: null }) => void;
  const dispatch = vi.fn(() => new Promise<{ status: "delivered"; items: QueueItem[]; error: null }>((resolve) => { finish = resolve; }));
  restoreTransport?.();
  restoreTransport = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Renderer reservation forbidden"); }, dispatchQueue: dispatch });
  const delivery = deliverQueueItem(item, () => true, 2000);
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(item.id, item.terminalId, 2000));
  expect(useQueue.getState().items[0].delivery).toEqual({ status: "sending", attemptedAt: 2000, owner: "native" });
  finish({ status: "delivered", items: [], error: null });
  expect(await delivery).toEqual({ status: "delivered" });
  expect(useQueue.getState().items).toEqual([]);
  expect(api.write).not.toHaveBeenCalled();
  expect(api.claim).not.toHaveBeenCalled();
});

it("reconciles a native delivery completed while the renderer was reloading", async () => {
  const item: QueueItem = { id: "native-request", terminalId: "agent", text: "Native durable delivery", at: 1000, source: "bridge",
    delivery: { status: "sending", attemptedAt: 2000, owner: "native" } };
  useQueue.setState({ items: [item] });
  restoreTransport?.();
  restoreTransport = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Renderer completion forbidden"); }, readQueue: async () => [] });
  await deliveryRules.refreshNativeQueue();
  expect(useQueue.getState().items).toEqual([]);
  expect(api.write).not.toHaveBeenCalled();
});

it("clears a failed native queue read only after a later read is acknowledged", async () => {
  useQueue.setState({ items: [], error: "Database unavailable" });
  let finish!: (items: QueueItem[]) => void;
  restoreTransport?.();
  restoreTransport = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => {},
    readQueue: () => new Promise((resolve) => { finish = resolve; }) });
  const reading = deliveryRules.refreshNativeQueue();
  expect(useQueue.getState().error).toBe("Database unavailable");
  finish([]);
  await reading;
  expect(useQueue.getState().error).toBeNull();
});

it("uses native queue scheduling for the native adapter and retains renderer scheduling for legacy adapters", () => {
  expect(queueTransport.nativeQueueScheduling()).toBe(false);
  restoreTransport?.();
  restoreTransport = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => {}, nativeScheduler: true });
  expect(queueTransport.nativeQueueScheduling()).toBe(true);
});

/** The runner used to remove the prompt before writing and never recover it after a PTY failure. */
it("refuses terminal input when the durable task reservation is not valid", async () => {
  vi.useFakeTimers();
  const item: QueueItem = { id: "request", taskId: "task-1", terminalId: "agent", text: "Review login", at: 1_000, source: "bridge" };
  useQueue.setState({ items: [item] });
  api.claim.mockRejectedValue({ code: "invalid_claim", message: "Task was cancelled" });
  api.write.mockResolvedValue(undefined);
  const delivery = deliverQueueItem(item, () => true, 2_000);
  await vi.runAllTimersAsync();
  expect((await delivery).status).toBe("uncertain");
  expect(api.write).not.toHaveBeenCalled();
  expect(useQueue.getState().items[0].delivery?.status).toBe("uncertain");
});

it("keeps a failed delivery in the persisted queue for review without retrying it automatically", async () => {
  const item: QueueItem = { id: "request", terminalId: "agent", text: "Review login", at: 1_000, source: "bridge" };
  const next: QueueItem = { ...item, id: "next", text: "Run tests" };
  useQueue.setState({ items: [item, next] });
  api.write.mockRejectedValue(new Error("The terminal closed"));

  const result = await deliverQueueItem(item, () => true, 2_000);

  expect(result).toEqual({ status: "uncertain", error: "The terminal closed" });
  expect(useQueue.getState().listFor("agent")).toEqual([
    { ...item, delivery: { status: "uncertain", attemptedAt: 2_000, error: "The terminal closed" } },
    next,
  ]);
  expect(JSON.parse(api.saved[KV_QUEUE])).toEqual(useQueue.getState().items);
  expect(dueItems(useQueue.getState().items, () => true)).toEqual([]);
});

it("reserves the prompt once when two delivery attempts reach the same queue head", async () => {
  const item: QueueItem = { id: "request", terminalId: "agent", text: "Review login", at: 1_000, source: "bridge" };
  useQueue.setState({ items: [item] });
  api.write.mockRejectedValue(new Error("The terminal closed"));
  const outcomes = await Promise.all([
    deliverQueueItem(item, () => true, 2_000),
    deliverQueueItem(item, () => true, 2_000),
  ]);
  expect(outcomes).toEqual([{ status: "uncertain", error: "The terminal closed" }, { status: "skipped" }]);
});

it("keeps a completed but unrecorded delivery for review when saving its acknowledgement fails", async () => {
  vi.useFakeTimers();
  const item: QueueItem = { id: "request", terminalId: "agent", text: "Review login", at: 1_000, source: "bridge" };
  useQueue.setState({ items: [item] });
  api.write.mockResolvedValue(undefined);
  restoreTransport?.();
  restoreTransport = setPrefsTransport({
    readPrefs: async () => api.saved,
    writePref: async (key, value) => {
      if (JSON.parse(value).length === 0) throw new Error("Disk full");
      api.saved[key] = value;
    },
  });
  const delivered = deliverQueueItem(item, () => true, 2_000);
  const outcome = delivered.then((value) => value, (error) => ({ rejected: String(error) }));
  await vi.runAllTimersAsync();
  expect(await outcome).toEqual({ status: "uncertain", error: "Disk full" });
  expect(useQueue.getState().listFor("agent")[0]).toMatchObject({ id: item.id, delivery: { status: "uncertain" } });
  expect(JSON.parse(api.saved[KV_QUEUE])[0].id).toBe(item.id);
});

it("acknowledges a successful delivery after the complete prompt and submit reached the terminal", async () => {
  vi.useFakeTimers();
  const item: QueueItem = { id: "request", terminalId: "agent", text: "Review login", at: 1_000, source: "bridge" };
  useQueue.setState({ items: [item] });
  const output: unknown[][] = [];
  api.write.mockImplementation(async (...request: unknown[]) => { output.push(request); });
  const delivered = deliverQueueItem(item, () => true, 2_000);
  await vi.runAllTimersAsync();
  expect(await delivered).toEqual({ status: "delivered" });
  expect(output).toEqual([["agent", "Review login", true]]);
  expect(useQueue.getState().listFor("agent")).toEqual([]);
  expect(JSON.parse(api.saved[KV_QUEUE])).toEqual([]);
});

it("preserves unseen native tasks through both reservation and delivery acknowledgement", async () => {
  vi.useFakeTimers();
  const request: QueueItem = { id: "request", terminalId: "agent", text: "Review login", at: 1_000, source: "user" };
  const native: QueueItem = { ...request, id: "native-task", terminalId: "other-agent", taskId: "work-1", text: "Native work" };
  useQueue.setState({ items: [request] });
  api.write.mockResolvedValue(undefined);
  const changes: { before: readonly QueueItem[]; after: readonly QueueItem[] }[] = [];
  restoreTransport?.();
  restoreTransport = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
    patchQueue: async (before, after) => { changes.push({ before, after }); return [native, ...after.filter((item) => item.id !== native.id)]; } });
  const sending = deliverQueueItem(request, () => true, 2_000);
  await vi.runAllTimersAsync();
  expect(await sending).toEqual({ status: "delivered" });
  expect(useQueue.getState().items).toEqual([native]);
  expect(changes[0].before).toEqual([request]);
  expect(changes[0].after[0].delivery?.status).toBe("sending");
  expect(changes[1].before.some((item) => item.id === native.id)).toBe(true);
});
