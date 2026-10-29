// Desktop adapters must preserve the wire protocol while the core stays host independent.
import { beforeEach, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { ipc, on } from "./client";

beforeEach(() => invoke.mockReset());

it("preserves explicit false when submitting terminal input", async () => {
  invoke.mockResolvedValue(undefined);
  await ipc.writePty("terminal-1", "draft", false);
  expect(invoke).toHaveBeenCalledWith("write_pty", {
    id: "terminal-1",
    data: "draft",
    submitPrompt: false,
  });
});

it("rejects a terminal kind the interface cannot represent", async () => {
  invoke.mockResolvedValue([{ kind: "unsupported" }]);
  await expect(ipc.listPtys()).rejects.toThrow("terminal kind");
});

it("rejects a missing numeric quota instead of reporting zero usage", async () => {
  invoke.mockResolvedValue({
    providers: [{ status: "ok", windows: [{ usedPercent: null }] }],
  });
  await expect(ipc.usageSnapshot()).rejects.toThrow("quota percentage");
});

it("validates live session events with the same rules as session snapshots", async () => {
  const observer = vi.fn();
  await on.sessionFeed(observer);
  const [topic, deliver] = listen.mock.calls.at(-1)!;
  expect(topic).toBe("session://feed");
  expect(() =>
    deliver({ payload: { events: [{ kind: "unsupported" }] } }),
  ).toThrow("feed kind");
  expect(observer).not.toHaveBeenCalled();
});
