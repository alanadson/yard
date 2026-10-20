/** A snapshot failure must reach notification history before its durable notice is acknowledged. */
import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ read: vi.fn(), acknowledge: vi.fn(), write: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: { checkpointNotices: boundary.read, checkpointAcknowledgeNotices: boundary.acknowledge, writePref: boundary.write } }));
import { refreshCheckpointNotices } from "./checkpointNotices";
import { useUI } from "../stores/uiStore";

beforeEach(() => { vi.resetAllMocks(); useUI.setState({ toasts: [], toastHistory: [] }); boundary.write.mockResolvedValue(undefined); });

it("shows the affected directory and recovery warning for a native snapshot failure", async () => {
  const notice = { id: "request", terminalId: "agent", root: "C:/repo", reason: "Disk full", at: 1000 };
  boundary.read.mockResolvedValue([notice]);
  boundary.acknowledge.mockResolvedValue(undefined);
  await refreshCheckpointNotices();
  expect(useUI.getState().toasts[0].message).toContain("C:/repo");
  expect(useUI.getState().toasts[0].message).toContain("sem checkpoint");
  expect(boundary.acknowledge.mock.calls[0][0]).toEqual([notice]);
});

it("keeps one visible warning when acknowledgement fails and the backend returns it again", async () => {
  const notice = { id: "unacknowledged", terminalId: "agent", root: "C:/repo", reason: "Disk full", at: 2000 };
  boundary.read.mockResolvedValue([notice]);
  boundary.acknowledge.mockRejectedValueOnce(new Error("Database unavailable")).mockResolvedValue(undefined);
  await expect(refreshCheckpointNotices()).rejects.toThrow("Database unavailable");
  await refreshCheckpointNotices();
  expect(useUI.getState().toasts).toHaveLength(1);
});
