/** Automatic snapshots follow the running process, and must not mistake a remote agent for local code. */
import { beforeEach, expect, it, vi } from "vitest";
import { prepareTaskCheckpoint, takeCheckpointedTask } from "./taskCheckpoint";
import { useProjects } from "../stores/projectsStore";
import { useQueue } from "../stores/queueStore";
import type { QueueItem } from "./queue";

const api = vi.hoisted(() => ({ list: vi.fn(), info: vi.fn(), create: vi.fn(), writePref: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: { listPtys: api.list, scmInfo: api.info, checkpointCreate: api.create, writePref: api.writePref } }));
vi.mock("./log", () => ({ uiLog: log }));

beforeEach(() => {
  vi.resetAllMocks();
  useQueue.setState({ items: [] });
  api.writePref.mockResolvedValue(undefined);
  useProjects.setState({ groups: [], terminals: [{ id: "agent", groupId: "group", cwd: "C:/repo", program: "claude", args: [], kind: "agent", slot: 0, sort: 0, alive: true, createdAt: 1000 }] });
});

/**
 * The regression this locks down: a checkpoint that could not be saved threw
 * out of here, so the queue runner left the head in place and retried it on
 * every tick, with a toast each time, and the prompt never went out. The
 * snapshot is best effort; the user's task is not.
 */
it("takes the queued task even when its code checkpoint cannot be saved, and says so once in the log", async () => {
  const item: QueueItem = { id: "task", terminalId: "agent", text: "Fix login", at: 1000, source: "user" };
  useQueue.setState({ items: [item] });
  api.list.mockResolvedValue([{ id: "agent", program: "claude.exe" }]);
  api.info.mockResolvedValue({ isRepo: true });
  api.create.mockRejectedValue(new Error("Disk full"));
  expect(await takeCheckpointedTask(item, () => true)).toEqual(item);
  expect(useQueue.getState().listFor("agent")).toEqual([]);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn.mock.calls[0][0]).toContain("Disk full");
});

it("does not take the replacement queue head if the checkpointed task was cancelled", async () => {
  const item: QueueItem = { id: "task", terminalId: "agent", text: "Fix login", at: 1000, source: "user" };
  const next = { ...item, id: "next", text: "Another task" };
  useQueue.setState({ items: [item, next] });
  api.list.mockResolvedValue([{ id: "agent", program: "claude.exe" }]);
  api.info.mockResolvedValue({ isRepo: true });
  api.create.mockImplementation(async () => { useQueue.getState().cancel(item.id); });
  expect(await takeCheckpointedTask(item, () => true)).toBeNull();
  expect(useQueue.getState().listFor("agent")).toEqual([next]);
});

it("does not take a local code checkpoint for a task running over SSH", async () => {
  api.list.mockResolvedValue([{ id: "agent", program: "C:/Windows/System32/OpenSSH/ssh.exe" }]);
  api.info.mockResolvedValue({ isRepo: true });
  expect(await prepareTaskCheckpoint("agent", { id: "task", text: "Fix login" })).toBeUndefined();
});

it("falls back to the terminal task when its saved group layout is malformed", async () => {
  useProjects.setState({ groups: [{ id: "group", projectId: "project", name: "Ground", layoutJson: "broken", suspended: false, sort: 0 }] });
  api.list.mockResolvedValue([{ id: "agent", program: "claude.exe" }]);
  api.info.mockResolvedValue({ isRepo: true });
  expect(await prepareTaskCheckpoint("agent")).toEqual({ root: "C:/repo", taskId: "agent", taskLabel: "agent" });
});
