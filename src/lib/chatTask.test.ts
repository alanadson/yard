/** Topic references must respect explicit task assignments and survive transcript export. */
import { beforeEach, expect, it, vi } from "vitest";
import { beginTurn, createChat, linkThreadTask, replyToTurn, selectThread } from "./chat";
import { useChats } from "../stores/chatsStore";
import * as taskChat from "./chatTask";
import type { WorkTask } from "./work";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

const boundary = vi.hoisted(() => ({ taskGet: vi.fn(), writePref: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: boundary }));

const task: WorkTask = { id: "task-1", title: "API review", request: "Review", criteria: [], status: "running", delivery: null,
  links: { projectId: null, terminalIds: ["terminal-1"], executorTerminalId: "terminal-1" }, createdAt: 1000, updatedAt: 1000, revision: 1 };
beforeEach(() => {
  boundary.taskGet.mockReset().mockResolvedValue(task);
  boundary.writePref.mockReset().mockResolvedValue(undefined);
  useChats.getState().load({ "chat.terminal.terminal-1": JSON.stringify(createChat()) });
  useProjects.setState({ loaded: true, activeGroupId: null, groups: [{ id: "board", projectId: null, name: "Board", sort: 0, suspended: false, layoutJson: "{}" }],
    terminals: [{ id: "terminal-1", groupId: "board", slot: 0, surface: "canvas", kind: "agent", program: "agent.exe", args: [], cwd: "C:/work", sort: 0, alive: false, createdAt: 1000 }] });
  useUI.setState({ modal: "work", modalParents: [], canvasReveal: null });
});

it("opens the task's exact conversation topic and reveals its card on the owning board", async () => {
  await taskChat.openTaskConversation("terminal-1", 2);
  expect(useChats.getState().byTerminal["terminal-1"].activeThread).toBe(2);
  expect(useChats.getState().byTerminal["terminal-1"].face).toBe("chat");
  expect(useProjects.getState().activeGroupId).toBe("board");
  expect(useUI.getState().canvasReveal).toEqual({ groupId: "board", id: "terminal-1" });
  expect(useUI.getState().modal).toBeNull();
});

it("refuses to open another topic while a reply is reserved and keeps the work panel in view", async () => {
  const document = beginTurn(createChat(), "pending", "Review", 1000);
  useChats.getState().load({ "chat.terminal.terminal-1": JSON.stringify(document) });
  await expect(taskChat.openTaskConversation("terminal-1", 2)).rejects.toThrow("pending");
  expect(useChats.getState().byTerminal["terminal-1"]).toEqual(document);
  expect(useUI.getState().modal).toBe("work");
  expect(useUI.getState().canvasReveal).toBeNull();
});

it("opening a removed terminal cannot create an orphan transcript or dismiss the task panel", async () => {
  useProjects.setState({ terminals: [] });
  await expect(taskChat.openTaskConversation("removed", 2)).rejects.toThrow("available");
  expect(useChats.getState().byTerminal.removed).toBeUndefined();
  expect(useUI.getState().modal).toBe("work");
  expect(boundary.writePref).not.toHaveBeenCalled();
});

it("associates an assigned task with the selected topic and persists the reference without completing work", async () => {
  const saved = new Map<string, string>();
  boundary.writePref.mockImplementation(async (key: string, value: string) => { saved.set(key, value); });
  await taskChat.associateChatTask("terminal-1", 0, "task-1");
  expect(useChats.getState().byTerminal["terminal-1"].threads[0].taskId).toBe("task-1");
  expect(JSON.parse(saved.get("chat.terminal.terminal-1")!).threads[0].taskId).toBe("task-1");
  expect(task.status).toBe("running");
});

it("refuses an unassigned task before changing the terminal transcript or its saved reference", async () => {
  boundary.taskGet.mockResolvedValueOnce({ ...task, links: { ...task.links, terminalIds: ["other-terminal"] } });
  await expect(taskChat.associateChatTask("terminal-1", 0, "task-1")).rejects.toThrow("assigned");
  expect(useChats.getState().byTerminal["terminal-1"]).toEqual(createChat());
  expect(boundary.writePref).not.toHaveBeenCalled();
});

it("refuses a stale task choice when another topic was selected while its assignment was being read", async () => {
  let finish!: (task: WorkTask) => void;
  boundary.taskGet.mockImplementationOnce(() => new Promise<WorkTask>((resolve) => { finish = resolve; }));
  const outcome = Promise.allSettled([taskChat.associateChatTask("terminal-1", 0, "task-1")]);
  await useChats.getState().update("terminal-1", (document) => selectThread(document, 1));
  finish(task);
  const [result] = await outcome;
  expect(result.status).toBe("rejected");
  expect(useChats.getState().byTerminal["terminal-1"].activeThread).toBe(1);
  expect(useChats.getState().byTerminal["terminal-1"].threads.every((topic) => !topic.taskId)).toBe(true);
});

it("offers only explicitly assigned tasks while retaining completed work as readable conversation context", () => {
  const completed = { ...task, id: "completed", status: "completed" };
  const other = { ...task, id: "other", links: { ...task.links, terminalIds: ["other-terminal"] } };
  expect(taskChat.chatTaskCandidates([task, other, completed], "terminal-1").map((candidate) => candidate.id)).toEqual(["task-1", "completed"]);
});

it("finds conversations for their original task even after the topic has been associated with later work", () => {
  const associated = linkThreadTask(createChat(), 0, "task-1");
  const completed = replyToTurn(beginTurn(associated, "request", "Review", 1000), "request", 0, "Done", 1100);
  const document = linkThreadTask(completed, 0, "task-2");
  expect(taskChat.relatedTaskChats({ "terminal-1": document }, "task-1")).toEqual([{ terminalId: "terminal-1", thread: 0, messages: 2 }]);
  expect(taskChat.relatedTaskChats({ "terminal-1": document }, "task-2")).toEqual([{ terminalId: "terminal-1", thread: 0, messages: 0 }]);
  expect(taskChat.relatedTaskChats({ "terminal-1": document }, "unrelated")).toEqual([]);
});
