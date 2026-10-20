/** A stopped provider must retain its request for review rather than replaying it on boot. */
import { beforeEach, expect, it, vi } from "vitest";
import { beginTurn, createChat, setChatDelivery } from "./chat";
import { useChats } from "../stores/chatsStore";
import * as recovery from "./chatRecovery";

const saved = vi.hoisted(() => new Map<string, string>());
const writePty = vi.hoisted(() => vi.fn(async (_id: string, _data: string) => {}));
vi.mock("./ipc", () => ({ ipc: { writePty, writePref: async (key: string, value: string) => { saved.set(key, value); } } }));

beforeEach(() => { saved.clear(); writePty.mockReset().mockResolvedValue(undefined); useChats.getState().load({}); });

it("a failed interruption still preserves the pending request as uncertain for manual review", async () => {
  const document = setChatDelivery(beginTurn(createChat(), "request", "Review", 1000), "request", "waiting");
  useChats.getState().load({ "chat.terminal.a": JSON.stringify(document) });
  writePty.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(recovery.requestChatInterrupt("a")).rejects.toThrow("Disconnected");
  expect(useChats.getState().byTerminal.a.pending).toEqual({ id: "request", thread: 0, delivery: "uncertain" });
  expect(useChats.getState().byTerminal.a.threads).toEqual(document.threads);
  expect(JSON.parse(saved.get("chat.terminal.a")!).pending.delivery).toBe("uncertain");
});

it("reconciles stopped pending providers while leaving live conversations waiting for their matching reply", async () => {
  const document = setChatDelivery(beginTurn(createChat(), "request", "Review", 1000), "request", "waiting");
  useChats.getState().load({ "chat.terminal.stopped": JSON.stringify(document), "chat.terminal.live": JSON.stringify(document) });
  await recovery.reconcileChatProcesses(new Set(["live"]));
  expect(useChats.getState().byTerminal.stopped.pending).toEqual({ id: "request", thread: 0, delivery: "uncertain" });
  expect(useChats.getState().byTerminal.stopped.threads).toEqual(document.threads);
  expect(useChats.getState().byTerminal.live).toEqual(document);
  expect(JSON.parse(saved.get("chat.terminal.stopped")!).pending.delivery).toBe("uncertain");
  expect(saved.has("chat.terminal.live")).toBe(false);
});
