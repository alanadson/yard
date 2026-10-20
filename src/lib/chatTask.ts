/** A topic references work without taking over its execution or approval lifecycle. */
import { useChats } from "../stores/chatsStore";
import { linkThreadTask, selectThread, type TerminalChat } from "./chat";
import { ipc } from "./ipc";
import type { WorkTask } from "./work";
import { goToTerminalId } from "./navigate";
import { useUI } from "../stores/uiStore";
import { useProjects } from "../stores/projectsStore";

export async function openTaskConversation(terminalId: string, thread: number): Promise<void> {
  if (!useProjects.getState().terminal(terminalId)) throw new Error("This conversation's terminal is no longer available");
  await useChats.getState().update(terminalId, (document) => {
    if (document.pending && document.activeThread !== thread) throw new Error("Another chat topic has a pending reply");
    return { ...selectThread(document, thread), face: "chat" };
  });
  useUI.getState().closeModal();
  goToTerminalId(terminalId);
}

export function chatTaskCandidates(tasks: WorkTask[], terminalId: string): WorkTask[] {
  return tasks.filter((task) => task.links.terminalIds.includes(terminalId));
}

export interface TaskChatReference { terminalId: string; thread: number; name?: string; messages: number }

export function relatedTaskChats(chats: Record<string, TerminalChat>, taskId: string): TaskChatReference[] {
  return Object.entries(chats).flatMap(([terminalId, document]) => document.threads.flatMap((topic, thread) => {
    const messages = topic.messages.filter((message) => message.taskId === taskId).length;
    return topic.taskId === taskId || messages > 0 ? [{ terminalId, thread, ...(topic.name ? { name: topic.name } : {}), messages }] : [];
  }));
}

export async function associateChatTask(terminalId: string, thread: number, taskId: string | null): Promise<void> {
  if (taskId) {
    const task = await ipc.taskGet(taskId);
    if (!task.links.terminalIds.includes(terminalId)) throw new Error("This task is not assigned to this terminal");
  }
  await useChats.getState().update(terminalId, (document) => {
    if (document.activeThread !== thread) throw new Error("The selected chat topic changed before its task could be associated");
    return linkThreadTask(document, thread, taskId);
  });
}
