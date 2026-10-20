/** The chat transcript belongs to the terminal, independently of the provider session. */
import { fold } from "./search";

export interface ChatAttachment {
  path: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  taskId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  attachments: ChatAttachment[];
}

export interface ChatThread {
  name?: string;
  taskId?: string;
  messages: ChatMessage[];
  draft: string;
  readCount: number;
}

export interface TerminalChat {
  version: 1;
  face: "terminal" | "chat";
  activeThread: number;
  threads: ChatThread[];
  pending?: { id: string; thread: number; delivery?: "sending" | "waiting" | "uncertain"; error?: string };
}

export const CHAT_THREAD_COUNT = 7;
export const CHAT_TEXT_MAX = 64_000;
export const CHAT_TOPIC_NAME_MAX = 80;
/** A topic keeps its newest messages: the whole topic is one kv row rewritten each turn. */
export const CHAT_TOPIC_MESSAGES_MAX = 500;

/** Appends one message and lets the oldest go past the cap; the read mark follows. */
function appendCapped(topic: ChatThread, message: ChatMessage): ChatThread {
  const messages = [...topic.messages, message];
  const excess = messages.length - CHAT_TOPIC_MESSAGES_MAX;
  if (excess <= 0) return { ...topic, messages };
  return { ...topic, messages: messages.slice(excess), readCount: Math.max(0, topic.readCount - excess) };
}

/** How many messages the card draws at first, and adds per "carregar mais". */
export const CHAT_VISIBLE_PAGE = 100;

/** The newest `limit` messages to draw, and how many older ones stay behind "carregar mais". */
export function messageWindow(messages: ChatMessage[], limit: number): { visible: ChatMessage[]; hidden: number } {
  const hidden = Math.max(0, messages.length - limit);
  return { visible: hidden ? messages.slice(hidden) : messages, hidden };
}

export function createChat(): TerminalChat {
  return {
    version: 1,
    face: "terminal",
    activeThread: 0,
    threads: Array.from({ length: CHAT_THREAD_COUNT }, () => ({ messages: [], draft: "", readCount: 0 })),
  };
}

export function beginTurn(document: TerminalChat, id: string, text: string, now: number, attachments: ChatAttachment[] = []): TerminalChat {
  if (document.pending) throw new Error("A chat turn is already pending");
  if (!text.trim() || text.length > CHAT_TEXT_MAX) throw new Error("Chat messages must contain between 1 and 64000 characters");
  const thread = document.activeThread;
  const taskId = document.threads[thread].taskId;
  const message: ChatMessage = { id, role: "user", text, createdAt: now, attachments, ...(taskId ? { taskId } : {}) };
  return {
    ...document,
    pending: { id, thread },
    threads: document.threads.map((topic, index) => index === thread
      ? { ...appendCapped(topic, message), draft: "" }
      : topic),
  };
}

export function setChatDelivery(document: TerminalChat, turn: string, delivery: "sending" | "waiting" | "uncertain", error?: string): TerminalChat {
  if (document.pending?.id !== turn) return document;
  return { ...document, pending: { ...document.pending, delivery, ...(error ? { error } : {}) } };
}

export function selectThread(document: TerminalChat, thread: number): TerminalChat {
  if (document.pending || !Number.isInteger(thread) || thread < 0 || thread >= CHAT_THREAD_COUNT) return document;
  return { ...document, activeThread: thread };
}

export function renameThread(document: TerminalChat, thread: number, name: string): TerminalChat {
  const title = name.trim();
  if (!Number.isInteger(thread) || thread < 0 || thread >= CHAT_THREAD_COUNT || title.length > CHAT_TOPIC_NAME_MAX) throw new Error("Topic identity and name must be valid");
  return { ...document, threads: document.threads.map((topic, index) => {
    if (index !== thread) return topic;
    const { name: _previous, ...rest } = topic;
    return title ? { ...rest, name: title } : rest;
  }) };
}

export function linkThreadTask(document: TerminalChat, thread: number, taskId: string | null): TerminalChat {
  if (document.pending) throw new Error("Wait for the current chat turn before changing its task");
  if (!Number.isInteger(thread) || thread < 0 || thread >= CHAT_THREAD_COUNT || (taskId !== null && !taskId.trim())) throw new Error("Topic and task identity must be valid");
  return { ...document, threads: document.threads.map((topic, index) => {
    if (index !== thread) return topic;
    const { taskId: _previous, ...rest } = topic;
    return taskId ? { ...rest, taskId } : rest;
  }) };
}

export function exportThreadJson(document: TerminalChat, terminalId: string, thread: number): string {
  if (!Number.isInteger(thread) || thread < 0 || thread >= document.threads.length) throw new Error("Topic identity must be valid");
  return JSON.stringify({ format: "yard-chat", version: 1, terminalId, thread: thread + 1,
    topic: document.threads[thread], ...(document.pending?.thread === thread ? { pending: document.pending } : {}),
  }, null, 2) + "\n";
}

export interface ChatExportLabels { title: string; user: string; assistant: string; attachments: string; draft: string; task?: string }

export function chatExportFormat(path: string): "json" | "markdown" {
  const file = path.split(/[\\/]/).pop() ?? "";
  return file.toLowerCase().endsWith(".json") ? "json" : "markdown";
}

export function exportThreadMarkdown(document: TerminalChat, thread: number, labels: ChatExportLabels): string {
  if (!Number.isInteger(thread) || thread < 0 || thread >= document.threads.length) throw new Error("Topic identity must be valid");
  const topic = document.threads[thread];
  const parts = [`# ${labels.title}`];
  if (topic.taskId && labels.task) parts.push(`${labels.task}: ${topic.taskId}`);
  for (const message of topic.messages) {
    parts.push(`## ${message.role === "user" ? labels.user : labels.assistant} (${new Date(message.createdAt).toISOString()})`);
    if (message.taskId && labels.task) parts.push(`${labels.task}: ${message.taskId}`);
    parts.push(message.text);
    if (message.attachments.length) parts.push(`### ${labels.attachments}`, message.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join("\n"));
    parts.push("---");
  }
  if (topic.draft) parts.push(`## ${labels.draft}`, topic.draft);
  return parts.join("\n\n") + "\n";
}

export function replyToTurn(document: TerminalChat, turn: string, thread: number, text: string, now: number, attachments: ChatAttachment[] = []): TerminalChat {
  if (document.pending?.id !== turn || document.pending.thread !== thread) throw new Error("The reply does not match the pending chat turn");
  if (!text.trim() || text.length > CHAT_TEXT_MAX) throw new Error("Chat messages must contain between 1 and 64000 characters");
  const { pending: _pending, ...rest } = document;
  const taskId = document.threads[thread].messages.find((message) => message.id === turn && message.role === "user")?.taskId;
  const message: ChatMessage = { id: `${turn}:reply`, role: "assistant", text, createdAt: now, attachments, ...(taskId ? { taskId } : {}) };
  return {
    ...rest,
    threads: document.threads.map((topic, index) => index === thread
      ? appendCapped(topic, message)
      : topic),
  };
}

export function parseChat(raw: string): TerminalChat | null {
  try {
    const value = JSON.parse(raw) as TerminalChat | null;
    if (!value || value.version !== 1 || !["terminal", "chat"].includes(value.face) ||
        !Number.isInteger(value.activeThread) || value.activeThread < 0 || value.activeThread >= CHAT_THREAD_COUNT ||
        !Array.isArray(value.threads) || value.threads.length !== CHAT_THREAD_COUNT) return null;
    if (!value.threads.every((topic) => topic && typeof topic.draft === "string" &&
      (topic.name === undefined || (typeof topic.name === "string" && topic.name.length <= CHAT_TOPIC_NAME_MAX)) &&
      (topic.taskId === undefined || (typeof topic.taskId === "string" && !!topic.taskId.trim())) &&
      Number.isInteger(topic.readCount) && topic.readCount >= 0 && Array.isArray(topic.messages) &&
      topic.readCount <= topic.messages.length && topic.messages.every((message) => message &&
        typeof message.id === "string" && ["user", "assistant"].includes(message.role) &&
        (message.taskId === undefined || (typeof message.taskId === "string" && !!message.taskId.trim())) &&
        typeof message.text === "string" && Number.isFinite(message.createdAt) &&
        Array.isArray(message.attachments) && message.attachments.every((attachment) => attachment &&
          typeof attachment.path === "string" && typeof attachment.name === "string")))) return null;
    if (value.pending !== undefined) {
      const pending = value.pending;
      if (!pending || typeof pending.id !== "string" || !pending.id.trim() ||
          !Number.isInteger(pending.thread) || pending.thread !== value.activeThread ||
          (pending.delivery !== undefined && !["sending", "waiting", "uncertain"].includes(pending.delivery)) ||
          (pending.error !== undefined && typeof pending.error !== "string") ||
          !value.threads[pending.thread].messages.some((message) => message.id === pending.id && message.role === "user")) return null;
    }
    return value;
  } catch { return null; }
}

export function unreadReplies(document: TerminalChat | undefined): number {
  return document?.threads.reduce((count, topic) => count + topic.messages.slice(topic.readCount).filter((message) => message.role === "assistant").length, 0) ?? 0;
}

export function markThreadRead(document: TerminalChat, thread: number): TerminalChat {
  const topic = document.threads[thread];
  if (!topic || topic.readCount === topic.messages.length) return document;
  return { ...document, threads: document.threads.map((current, index) => index === thread ? { ...current, readCount: current.messages.length } : current) };
}

export function clearThread(document: TerminalChat, thread: number): TerminalChat {
  if (document.pending) throw new Error("Wait for the current chat turn before clearing a topic");
  return { ...document, threads: document.threads.map((topic, index) => index === thread ? { ...topic, messages: [], draft: "", readCount: 0 } : topic) };
}

export function cancelTurn(document: TerminalChat, turn: string): TerminalChat {
  if (document.pending?.id !== turn) return document;
  const { pending: _pending, ...rest } = document;
  return rest;
}

export function releaseUncertainTurn(document: TerminalChat, turn: string): TerminalChat {
  if (document.pending?.id !== turn || document.pending.delivery !== "uncertain") return document;
  const thread = document.pending.thread;
  const topic = document.threads[thread];
  const request = topic.messages.find((message) => message.id === turn && message.role === "user");
  return setThreadDraft(cancelTurn(document, turn), thread, topic.draft || request?.text || "");
}

export function setThreadDraft(document: TerminalChat, thread: number, draft: string): TerminalChat {
  return { ...document, threads: document.threads.map((topic, index) => index === thread ? { ...topic, draft } : topic) };
}

export function quoteMessage(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
}

export function matchingMessages(messages: ChatMessage[], query: string): ChatMessage[] {
  const search = fold(query.trim());
  return search ? messages.filter((message) => fold(message.text).includes(search)) : messages;
}
