/** Chat topics must retain their identity when a terminal or its agent restarts. */
import { describe, expect, it } from "vitest";
import * as chat from "./chat";

describe("terminal chat", () => {
  it("includes each original task reference in a Markdown export even after the topic switches to different work", () => {
    const associated = chat.linkThreadTask(chat.createChat(), 0, "task-1");
    const document = chat.linkThreadTask(chat.replyToTurn(chat.beginTurn(associated, "request", "Review", 1000), "request", 0, "Done", 1100), 0, "task-2");
    const markdown = chat.exportThreadMarkdown(document, 0, { title: "API review", user: "User", assistant: "Agent", attachments: "Attachments", draft: "Draft", task: "Task" });
    expect(markdown).toContain("Task: task-2");
    expect(markdown.match(/Task: task-1/g)).toHaveLength(2);
  });

  it.each([42, null, "", "   "])("refuses malformed stored task references in topics and messages (%j)", (taskId) => {
    const document = chat.beginTurn(chat.createChat(), "request", "Review", 1000);
    const invalidTopic = { ...document, threads: [{ ...document.threads[0], taskId }, ...document.threads.slice(1)] };
    expect(chat.parseChat(JSON.stringify(invalidTopic))).toBeNull();
    const invalidMessage = { ...document, threads: [{ ...document.threads[0], messages: [{ ...document.threads[0].messages[0], taskId }] }, ...document.threads.slice(1)] };
    expect(chat.parseChat(JSON.stringify(invalidMessage))).toBeNull();
  });

  it("records the task on each request and reply so changing a topic association cannot rewrite earlier work", () => {
    const topic = chat.linkThreadTask(chat.createChat(), 0, "task-1");
    const requested = chat.beginTurn(topic, "turn-1", "Review", 1000);
    expect(requested.threads[0].messages[0].taskId).toBe("task-1");
    const replied = chat.replyToTurn(requested, "turn-1", 0, "Done", 1100);
    expect(replied.threads[0].messages[1].taskId).toBe("task-1");
    const relinked = chat.linkThreadTask(replied, 0, "task-2");
    expect(relinked.threads[0].messages.every((message) => message.taskId === "task-1")).toBe(true);
    expect(chat.beginTurn(relinked, "turn-2", "Next", 1200).threads[0].messages.at(-1)?.taskId).toBe("task-2");
  });

  it("associates one topic with a task without changing its name, messages or the other topics", () => {
    const named = chat.renameThread(chat.createChat(), 0, "API review");
    const document = chat.replyToTurn(chat.beginTurn(named, "request", "Review", 1000), "request", 0, "Done", 1100);
    const associated = chat.linkThreadTask(document, 0, "task-1");
    expect(associated.threads[0].taskId).toBe("task-1");
    expect(associated.threads[0].name).toBe("API review");
    expect(associated.threads[0].messages).toEqual(document.threads[0].messages);
    expect(associated.threads.slice(1)).toEqual(document.threads.slice(1));
    expect(chat.parseChat(JSON.stringify(associated))).toEqual(associated);
  });

  it("reviewing uncertain delivery keeps a newer draft instead of replacing it with the original request", () => {
    const document = chat.setChatDelivery(chat.beginTurn(chat.createChat(), "request", "Review", 1000), "request", "uncertain");
    const drafted = chat.setThreadDraft(document, 0, "Next question");
    expect(chat.releaseUncertainTurn(drafted, "request").threads[0].draft).toBe("Next question");
  });

  it("a late reply that wins before review cannot be replaced by the retired request", () => {
    const document = chat.setChatDelivery(chat.beginTurn(chat.createChat(), "request", "Review", 1000), "request", "uncertain");
    const answered = chat.replyToTurn(document, "request", 0, "Done", 1100);
    expect(chat.releaseUncertainTurn(answered, "request")).toBe(answered);
    expect(chat.releaseUncertainTurn(document, "older-request")).toBe(document);
  });

  it("prepares an uncertain request as a draft only after review while preserving its original transcript", () => {
    const document = chat.setChatDelivery(chat.beginTurn(chat.createChat(), "request", "Review", 1000), "request", "uncertain");
    const next = chat.releaseUncertainTurn(document, "request");
    expect(next.pending).toBeUndefined();
    expect(next.threads[0].draft).toBe("Review");
    expect(next.threads[0].messages).toEqual(document.threads[0].messages);
    expect(document.pending?.id).toBe("request");
  });

  it.each([null, {}, { id: "", thread: 0 }, { id: "request", thread: 7 },
    { id: "request", thread: 0, delivery: "complete" }, { id: "request", thread: 0, error: 42 },
    { id: "missing", thread: 0 }, { id: "request", thread: 1 },
  ])("refuses a malformed pending turn instead of leaving the saved topic locked (%j)", (pending) => {
    const document = chat.beginTurn(chat.createChat(), "request", "Review", 1000);
    expect(chat.parseChat(JSON.stringify({ ...document, pending }))).toBeNull();
  });

  it("renames a topic without rewriting its messages or changing the pending reply identity", () => {
    const document = chat.beginTurn(chat.createChat(), "turn-1", "Review the API", 1000);
    const named = chat.renameThread(document, 0, "  API review  ");
    expect(named.threads[0].name).toBe("API review");
    expect(named.threads[0].messages).toEqual(document.threads[0].messages);
    expect(named.pending).toEqual(document.pending);
    expect(named.activeThread).toBe(document.activeThread);
    expect(chat.parseChat(JSON.stringify(named))).toEqual(named);
  });

  it("exports one named topic with its original message identities and attachments", () => {
    const named = chat.renameThread(chat.createChat(), 0, "API review");
    const requested = chat.beginTurn(named, "turn-1", "Review **this** file", 1000, [{ path: "C:/project/proof.png", name: "proof.png" }]);
    const document = chat.replyToTurn(requested, "turn-1", 0, "The API remains compatible.", 1100);
    document.threads[1].draft = "Private unrelated draft";
    const exported = JSON.parse(chat.exportThreadJson(document, "terminal-1", 0));
    expect(exported.terminalId).toBe("terminal-1");
    expect(exported.thread).toBe(1);
    expect(exported.topic.name).toBe("API review");
    expect(exported.topic.messages).toEqual(document.threads[0].messages);
    expect(JSON.stringify(exported)).not.toContain("Private unrelated draft");
  });

  it("exports Markdown in message order with the original content and attachment references", () => {
    const requested = chat.beginTurn(chat.createChat(), "turn-1", "Review **this** file", 1000, [{ path: "C:/project/proof.png", name: "proof.png" }]);
    const document = chat.replyToTurn(requested, "turn-1", 0, "The API remains compatible.", 1100);
    const markdown = chat.exportThreadMarkdown(document, 0, { title: "API review", user: "User", assistant: "Agent", attachments: "Attachments", draft: "Draft" });
    expect(markdown.startsWith("# API review\n")).toBe(true);
    expect(markdown).toContain("Review **this** file");
    expect(markdown).toContain("proof.png: C:/project/proof.png");
    expect(markdown).toContain("The API remains compatible.");
    expect(markdown.indexOf("Review **this** file")).toBeLessThan(markdown.indexOf("The API remains compatible."));
  });

  it("chooses a chat export format from the file extension rather than a dotted parent folder", () => {
    expect(chat.chatExportFormat("C:/work.json/conversation.md")).toBe("markdown");
    expect(chat.chatExportFormat("C:/exports/conversation.JSON")).toBe("json");
  });

  it.each([42, { label: "Invalid name" }, "x".repeat(81)])("refuses malformed stored topic names before rendering them (%j)", (name) => {
    const document = chat.createChat();
    const stored = { ...document, threads: [{ ...document.threads[0], name }, ...document.threads.slice(1)] };
    expect(chat.parseChat(JSON.stringify(stored))).toBeNull();
  });
  it("starts with seven independent topics and the first topic selected", () => {
    const document = chat.createChat();
    expect(document.activeThread).toBe(0);
    expect(document.threads).toHaveLength(7);
    expect(new Set(document.threads).size).toBe(7);
    expect(document.threads.every((thread) => thread.messages.length === 0)).toBe(true);
  });

  it("records a request in the selected topic and binds its turn to that topic", () => {
    const document = chat.createChat();
    document.activeThread = 3;
    document.threads[3].draft = "Review this file";
    const next = chat.beginTurn(document, "turn-1", "Review this file", 1000);
    expect(next.threads[3].messages).toEqual([
      { id: "turn-1", role: "user", text: "Review this file", createdAt: 1000, attachments: [] },
    ]);
    expect(next.pending).toEqual({ id: "turn-1", thread: 3 });
    expect(next.threads[3].draft).toBe("");
    expect(document.threads[3].messages).toEqual([]);
  });

  it("keeps the current topic while its agent is answering", () => {
    const document = chat.beginTurn(chat.createChat(), "turn-1", "Review", 1000);
    expect(chat.selectThread(document, 2)).toBe(document);
    expect(() => chat.beginTurn(document, "turn-2", "Another request", 1001)).toThrow();
  });

  it("stores an explicit agent reply in its original topic and completes the turn", () => {
    const document = chat.beginTurn(chat.createChat(), "turn-1", "Review", 1000);
    const next = chat.replyToTurn(document, "turn-1", 0, "**Looks good**", 1100);
    expect(next.threads[0].messages.at(-1)).toEqual({
      id: "turn-1:reply", role: "assistant", text: "**Looks good**", createdAt: 1100, attachments: [],
    });
    expect(next.pending).toBeUndefined();
    expect(chat.selectThread(next, 2).activeThread).toBe(2);
  });

  it.each([["old-turn", 0], ["turn-1", 1]])("rejects an answer for a different turn or topic (%s, %s)", (turn, thread) => {
    const document = chat.beginTurn(chat.createChat(), "turn-1", "Review", 1000);
    expect(() => chat.replyToTurn(document, turn as string, thread as number, "Answer", 1100)).toThrow();
    expect(document.threads[0].messages).toHaveLength(1);
  });

  it("restores messages, drafts and the selected topic after a relaunch", () => {
    const document = chat.replyToTurn(chat.beginTurn(chat.createChat(), "turn-1", "Review", 1000), "turn-1", 0, "Done", 1100);
    const selected = chat.selectThread(document, 4);
    selected.threads[4].draft = "Next request";
    expect(chat.parseChat(JSON.stringify(selected))).toEqual(selected);
  });

  it.each(["null", "{}", JSON.stringify({ ...chat.createChat(), version: 2 }), JSON.stringify({ ...chat.createChat(), activeThread: 7 }), JSON.stringify({ ...chat.createChat(), threads: [] })])("refuses an invalid stored transcript without pretending it is a new chat (%s)", (raw) => {
    expect(chat.parseChat(raw)).toBeNull();
  });

  it.each([
    { messages: null, draft: "", readCount: 0 },
    { messages: [], draft: null, readCount: 0 },
    { messages: [], draft: "", readCount: -1 },
    { messages: [{ id: "x", role: "system", text: "Bad", createdAt: 1, attachments: [] }], draft: "", readCount: 0 },
    { messages: [{ id: "x", role: "assistant", text: "Bad", createdAt: 1, attachments: [null] }], draft: "", readCount: 0 },
  ])("refuses malformed topic contents before rendering them", (topic) => {
    const document = { ...chat.createChat(), threads: [topic, ...chat.createChat().threads.slice(1)] };
    expect(chat.parseChat(JSON.stringify(document))).toBeNull();
  });

  it.each(["", "   ", "x".repeat(64_001)])("refuses an empty or oversized chat message", (text) => {
    expect(() => chat.beginTurn(chat.createChat(), "request", text, 1000)).toThrow();
    const document = chat.beginTurn(chat.createChat(), "request", "Review", 1000);
    expect(() => chat.replyToTurn(document, "request", 0, text, 1100)).toThrow();
  });

  it("counts unread agent replies without counting the user's own requests", () => {
    let document = chat.beginTurn(chat.createChat(), "request", "Review", 1000);
    expect(chat.unreadReplies(document)).toBe(0);
    document = chat.replyToTurn(document, "request", 0, "Done", 1100);
    expect(chat.unreadReplies(document)).toBe(1);
    const read = chat.markThreadRead(document, 0);
    expect(chat.unreadReplies(read)).toBe(0);
    expect(read.threads[0].messages).toEqual(document.threads[0].messages);
  });

  it("clears one topic while preserving the other six conversations and drafts", () => {
    const document = chat.replyToTurn(chat.beginTurn(chat.createChat(), "request", "Review", 1000), "request", 0, "Done", 1100);
    document.threads[1].draft = "Keep this draft";
    const next = chat.clearThread(document, 0);
    expect(next.threads[0]).toEqual(chat.createChat().threads[0]);
    expect(next.threads.slice(1)).toEqual(document.threads.slice(1));
    expect(document.threads[0].messages).toHaveLength(2);
  });

  it("clearing messages keeps the topic's chosen name for the next conversation", () => {
    const named = chat.renameThread(chat.createChat(), 0, "API review");
    const document = chat.replyToTurn(chat.beginTurn(named, "request", "Review", 1000), "request", 0, "Done", 1100);
    const next = chat.clearThread(document, 0);
    expect(next.threads[0].name).toBe("API review");
    expect(next.threads[0].messages).toEqual([]);
  });

  it("refuses to clear a conversation while its answer is pending", () => {
    const document = chat.beginTurn(chat.createChat(), "request", "Review", 1000);
    expect(() => chat.clearThread(document, 0)).toThrow();
    expect(document.threads[0].messages).toHaveLength(1);
  });

  it("interrupts only the named turn without erasing the conversation", () => {
    const document = chat.beginTurn(chat.createChat(), "request", "Review", 1000);
    expect(chat.cancelTurn(document, "older-request")).toBe(document);
    const next = chat.cancelTurn(document, "request");
    expect(next.pending).toBeUndefined();
    expect(next.threads).toEqual(document.threads);
    expect(() => chat.replyToTurn(next, "request", 0, "Late reply", 1100)).toThrow();
  });

  it("keeps each draft in its own topic when another conversation is selected", () => {
    const document = chat.selectThread(chat.createChat(), 2);
    const next = chat.setThreadDraft(document, 0, "First draft");
    expect(next.activeThread).toBe(2);
    expect(next.threads[0].draft).toBe("First draft");
    expect(next.threads[2].draft).toBe("");
    expect(document.threads[0].draft).toBe("");
  });

  it("quotes every line without changing the message being answered", () => {
    expect(chat.quoteMessage("First line\n\nSecond line")).toBe("> First line\n> \n> Second line\n\n");
  });

  it("finds messages without requiring the accents used by the writer", () => {
    const document = chat.replyToTurn(chat.beginTurn(chat.createChat(), "request", "Revise", 1000), "request", 0, "Revisão concluída", 1100);
    expect(chat.matchingMessages(document.threads[0].messages, "revisao").map((message) => message.text)).toEqual(["Revisão concluída"]);
    expect(chat.matchingMessages(document.threads[0].messages, "")).toHaveLength(2);
  });
});

/**
 * A topic is one kv row rewritten whole on every turn, and the card rendered
 * every message of it as Markdown: a long-lived topic made each turn and each
 * render cost more than the last. A topic keeps its newest 500 messages, and
 * the card draws the newest 100 with a way to ask for more.
 */
describe("chat size limits", () => {
  const topicWith = (count: number, readCount = count) => {
    const document = chat.createChat();
    const messages = Array.from({ length: count }, (_, i): chat.ChatMessage => ({
      id: `m${i}`, role: i % 2 ? "assistant" : "user", text: `message ${i}`, createdAt: i, attachments: [],
    }));
    return { ...document, threads: document.threads.map((topic, index) => index === 0 ? { ...topic, messages, readCount } : topic) };
  };

  it("keeps only the newest messages of a topic when a request is added", () => {
    const document = chat.beginTurn(topicWith(chat.CHAT_TOPIC_MESSAGES_MAX), "request", "Next", 9_000);
    const messages = document.threads[0].messages;
    expect(messages).toHaveLength(chat.CHAT_TOPIC_MESSAGES_MAX);
    expect(messages[0].id).toBe("m1");
    expect(messages.at(-1)?.id).toBe("request");
    expect(chat.parseChat(JSON.stringify(document))).not.toBeNull();
  });

  it("keeps only the newest messages when a reply arrives, and the read mark follows the trim", () => {
    const requested = chat.beginTurn(topicWith(chat.CHAT_TOPIC_MESSAGES_MAX - 1, 10), "request", "Next", 9_000);
    const replied = chat.replyToTurn(requested, "request", 0, "Done", 9_100);
    const topic = replied.threads[0];
    expect(topic.messages).toHaveLength(chat.CHAT_TOPIC_MESSAGES_MAX);
    expect(topic.messages.at(-1)?.text).toBe("Done");
    // One old message left: ten read became nine, still the same messages.
    expect(topic.readCount).toBe(9);
    expect(chat.parseChat(JSON.stringify(replied))).not.toBeNull();
  });

  it("draws the newest messages and says how many older ones are waiting", () => {
    const messages = topicWith(250).threads[0].messages;
    const page = chat.messageWindow(messages, 100);
    expect(page.visible).toHaveLength(100);
    expect(page.visible[0].id).toBe("m150");
    expect(page.hidden).toBe(150);
    expect(chat.messageWindow(messages, 300)).toEqual({ visible: messages, hidden: 0 });
  });
});
