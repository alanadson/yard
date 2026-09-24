/** Switching tasks during disk reads must never show another worktree's checkpoint as restorable. */
import { beforeEach, expect, it, vi } from "vitest";
import { useCheckpoints } from "./checkpointsStore";
import { useUI } from "./uiStore";

const api = vi.hoisted(() => ({ list: vi.fn(), preview: vi.fn(), restore: vi.fn(), create: vi.fn(), delete: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { checkpointList: api.list, checkpointPreview: api.preview, checkpointRestore: api.restore, checkpointCreate: api.create, checkpointDelete: api.delete } }));

beforeEach(() => { vi.resetAllMocks(); useCheckpoints.getState().close(); });

it("removes a deleted checkpoint from the list and clears its restore preview", async () => {
  api.list.mockResolvedValueOnce([{ id: "old" }]).mockResolvedValueOnce([]);
  api.preview.mockResolvedValue({ files: [], token: "token", blockedReason: null });
  api.delete.mockResolvedValue(undefined);
  await useCheckpoints.getState().open({ root: "C:/repo", taskId: "task", taskLabel: "Task" });
  await useCheckpoints.getState().select("old");
  await useCheckpoints.getState().remove("old");
  expect(api.delete.mock.calls).toEqual([["C:/repo", "old"]]);
  expect(useCheckpoints.getState().rows).toEqual([]);
  expect(useCheckpoints.getState().preview).toBeNull();
});

it("opens the checkpoint manager as a modal so it owns focus and covers browser portals", async () => {
  api.list.mockResolvedValue([]);
  useUI.setState({ modal: null });
  await useCheckpoints.getState().open({ root: "C:/repo", taskId: "task", taskLabel: "Task" });
  expect(useUI.getState().modal).toBe("checkpoints");
  useCheckpoints.getState().close();
  expect(useUI.getState().modal).toBeNull();
});

it("creates a manual checkpoint for the task currently open in the manager", async () => {
  const saved = { id: "created", label: "Before rename", taskId: "task" };
  api.list.mockResolvedValueOnce([]).mockResolvedValueOnce([saved]);
  api.create.mockResolvedValue(saved);
  await useCheckpoints.getState().open({ root: "C:/front", taskId: "task", taskLabel: "Rename" });
  await useCheckpoints.getState().create("Before rename");
  expect(api.create.mock.calls).toEqual([["C:/front", "task", "Rename", "Before rename"]]);
  expect(useCheckpoints.getState().rows.map((r) => r.id)).toEqual(["created"]);
});

it("does not restore a task that changed while its confirmation was open", async () => {
  api.list.mockResolvedValue([{ id: "old", label: "Before", taskLabel: "Old" }]);
  api.preview.mockResolvedValue({ files: [{ path: "code.ts" }], token: "review-token", blockedReason: null });
  await useCheckpoints.getState().open({ root: "C:/old", taskId: "old-task", taskLabel: "Old" });
  await useCheckpoints.getState().select("old");
  let answer!: (value: boolean) => void;
  const restoring = useCheckpoints.getState().restore(() => null, () => new Promise((resolve) => { answer = resolve; }));
  await useCheckpoints.getState().open({ root: "C:/new", taskId: "new-task", taskLabel: "New" });
  answer(true);
  await restoring;
  expect(api.restore).not.toHaveBeenCalled();
});

it("clears a pending restore preview when the manager switches to another task", async () => {
  api.list.mockResolvedValue([{ id: "old" }]);
  await useCheckpoints.getState().open({ root: "C:/old", taskId: "old-task", taskLabel: "Old" });
  let finish!: (result: unknown) => void;
  api.preview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = useCheckpoints.getState().select("old");
  await useCheckpoints.getState().open({ root: "C:/new", taskId: "new-task", taskLabel: "New" });
  finish({ files: [{ path: "old-code.ts" }], token: "old-token" });
  await pending;
  expect(useCheckpoints.getState().preview).toBeNull();
  expect(useCheckpoints.getState().selectedId).toBeNull();
});

it("discards the previous task's list when its disk read finishes after switching worktrees", async () => {
  let oldReply!: (rows: unknown[]) => void;
  api.list.mockImplementationOnce(() => new Promise((resolve) => { oldReply = resolve; }));
  api.list.mockResolvedValueOnce([{ id: "new", root: "C:/new", taskId: "new-task" }]);
  const old = useCheckpoints.getState().open({ root: "C:/old", taskId: "old-task", taskLabel: "Old" });
  await useCheckpoints.getState().open({ root: "C:/new", taskId: "new-task", taskLabel: "New" });
  oldReply([{ id: "old", root: "C:/old", taskId: "old-task" }]);
  await old;
  expect(useCheckpoints.getState().rows.map((r) => r.id)).toEqual(["new"]);
  expect(useCheckpoints.getState().scope?.root).toBe("C:/new");
});
