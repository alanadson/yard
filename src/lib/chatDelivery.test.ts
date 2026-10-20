/** A visible chat request must be saved before it reaches the real agent's terminal. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  writePref: vi.fn(async (_key: string, _value: string) => {}),
  writePty: vi.fn(async (_id: string, _text: string, _submitPrompt?: boolean) => {}),
  listPtys: vi.fn(async () => []),
}));
vi.mock("./ipc", () => ({ ipc: boundary }));
import * as delivery from "./chatDelivery";
import { useChats } from "../stores/chatsStore";
import { useProjects } from "../stores/projectsStore";
import { useTerminals } from "../stores/terminalsStore";
import { createChat, linkThreadTask, replyToTurn, selectThread } from "./chat";

beforeEach(() => {
  vi.useFakeTimers();
  boundary.writePref.mockReset().mockResolvedValue(undefined);
  boundary.writePty.mockReset().mockResolvedValue(undefined);
  useProjects.setState({ projects: [], groups: [], terminals: [], activeGroupId: null, activeProjectId: null });
  useTerminals.setState({ byId: {} });
  useChats.getState().load({});
});
afterEach(() => vi.useRealTimers());

function caller() {
  const groupId = useProjects.getState().addBoard("Workspace");
  const id = useProjects.getState().addTerminal({ groupId, title: "Agent", kind: "agent", program: "agent.exe", cwd: "C:/project" });
  useTerminals.getState().patch(id, { state: "running" });
  return id;
}

it("delivers a saved request with the topic and turn needed for an explicit reply", async () => {
  const id = caller();
  const output: string[] = [];
  boundary.writePty.mockImplementation(async (_id, text) => {
    expect(useChats.getState().byTerminal[id].threads[0].messages[0].text).toBe("Review the file");
    output.push(text);
  });
  const pending = delivery.sendChat(id, "Review the file", "turn-1", 1000);
  await vi.waitFor(() => expect(output.length).toBeGreaterThan(0));
  await vi.runAllTimersAsync();
  await pending;
  expect(output.join("")).toContain('yard chat reply --thread 1 --turn "turn-1"');
  expect(output.join("")).toContain("Review the file");
  expect(boundary.writePty.mock.calls).toHaveLength(1);
  expect(boundary.writePty.mock.calls[0][2]).toBe(true);
});

it("includes the associated work reference in the prompt while retaining the chat reply contract", async () => {
  const id = caller();
  useChats.getState().load({ [`chat.terminal.${id}`]: JSON.stringify(linkThreadTask(createChat(), 0, "task-1")) });
  const output: string[] = [];
  boundary.writePty.mockImplementation(async (_id, text) => { output.push(text); });
  const pending = delivery.sendChat(id, "Review the task", "turn-1", 1000);
  await vi.waitFor(() => expect(output.length).toBeGreaterThan(0));
  await vi.runAllTimersAsync();
  await pending;
  expect(output.join("")).toContain('yard task show "task-1"');
  expect(output.join("")).toContain('yard chat reply --thread 1 --turn "turn-1"');
  expect(useChats.getState().byTerminal[id].threads[0].messages[0].taskId).toBe("task-1");
});

it("keeps a failed write reserved for review instead of automatically enabling another send", async () => {
  const id = caller();
  boundary.writePty.mockRejectedValueOnce(new Error("Terminal disconnected"));
  await expect(delivery.sendChat(id, "Review the file", "turn-1", 1000)).rejects.toThrow("Terminal disconnected");
  expect(useChats.getState().byTerminal[id].pending).toEqual({ id: "turn-1", thread: 0, delivery: "uncertain", error: "Terminal disconnected" });
  expect(useChats.getState().byTerminal[id].threads[0].messages[0].text).toBe("Review the file");
  expect(useChats.getState().byTerminal[id].threads[0].draft).toBe("");
});

it("retains an uncertain turn so a legitimate late reply is accepted instead of prompting duplicate delivery", async () => {
  const id = caller();
  boundary.writePty.mockRejectedValueOnce(new Error("Acknowledgement disconnected"));
  await expect(delivery.sendChat(id, "Review the file", "turn-1", 1000)).rejects.toThrow("Acknowledgement disconnected");
  const document = useChats.getState().byTerminal[id];
  expect(document.pending?.id).toBe("turn-1");
  expect(document.pending?.delivery).toBe("uncertain");
  expect(document.threads[0].messages[0].text).toBe("Review the file");
  const replied = replyToTurn(document, "turn-1", 0, "The request arrived and was completed.", 1100);
  expect(replied.pending).toBeUndefined();
  expect(replied.threads[0].messages.at(-1)?.text).toBe("The request arrived and was completed.");
});

it("refuses a draft whose topic changed before the request could be saved", async () => {
  const id = caller();
  const document = selectThread(createChat(), 2);
  useChats.getState().load({ [`chat.terminal.${id}`]: JSON.stringify(document) });
  const result = Promise.allSettled([delivery.sendChat(id, "Review", "turn-1", 1000, 0)]);
  await vi.advanceTimersByTimeAsync(200);
  const [settled] = await result;
  expect(settled.status).toBe("rejected");
  expect(useChats.getState().byTerminal[id].threads.every((topic) => topic.messages.length === 0)).toBe(true);
});
