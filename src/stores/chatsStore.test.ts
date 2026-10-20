/** A chat must survive relaunch without an unacknowledged write erasing its transcript. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ writePref: vi.fn(async (_key: string, _value: string) => {}) }));
vi.mock("../lib/ipc", () => ({ ipc: boundary }));
import * as store from "./chatsStore";
import { beginTurn, createChat } from "../lib/chat";

beforeEach(() => {
  boundary.writePref.mockReset().mockResolvedValue(undefined);
});

describe("chat persistence", () => {
  it("restores an interrupted write as uncertain while retaining the turn for a late reply", () => {
    const document = beginTurn(createChat(), "request", "Review", 1000);
    document.pending!.delivery = "sending";
    store.useChats.getState().load({ "chat.terminal.a": JSON.stringify(document) });
    const recovered = store.useChats.getState().byTerminal.a;
    expect(recovered.pending).toEqual({ id: "request", thread: 0, delivery: "uncertain" });
    expect(recovered.threads).toEqual(document.threads);
    expect(() => beginTurn(recovered, "duplicate", "Review", 1100)).toThrow("pending");
  });

  it("restores each terminal independently from the workspace backup", () => {
    const document = beginTurn(createChat(), "request", "Review", 1000);
    store.useChats.getState().load({ "chat.terminal.a": JSON.stringify(document), "chat.terminal.b": JSON.stringify(createChat()), "unrelated": "{}" });
    expect(store.useChats.getState().byTerminal.a).toEqual(document);
    expect(store.useChats.getState().byTerminal.b).toEqual(createChat());
    expect(Object.keys(store.useChats.getState().byTerminal)).toEqual(["a", "b"]);
  });

  it("keeps the transcript and draft intact when storage refuses a new request", async () => {
    const document = createChat();
    document.threads[0].draft = "Review";
    store.useChats.getState().load({ "chat.terminal.a": JSON.stringify(document) });
    boundary.writePref.mockRejectedValueOnce(new Error("Disk full"));
    await expect(store.useChats.getState().update("a", (current) => beginTurn(current, "request", "Review", 1000))).rejects.toThrow("Disk full");
    expect(store.useChats.getState().byTerminal.a).toEqual(document);
  });

  it("accepts only one of two simultaneous requests to the same terminal", async () => {
    store.useChats.getState().load({});
    let release!: () => void;
    const saved: Record<string, string> = {};
    boundary.writePref.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => { release = resolve; });
      saved[key] = value;
    });
    const first = store.useChats.getState().update("a", (current) => beginTurn(current, "first", "First request", 1000));
    const second = store.useChats.getState().update("a", (current) => beginTurn(current, "second", "Second request", 1001));
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    expect((await results).filter((result) => result.status === "fulfilled")).toHaveLength(1);
    store.useChats.getState().load(saved);
    expect(store.useChats.getState().byTerminal.a.pending?.id).toBe("first");
  });

  it("protects an unreadable transcript from being overwritten by an empty conversation", async () => {
    store.useChats.getState().load({ "chat.terminal.a": "{}" });
    await expect(store.useChats.getState().update("a", (current) => beginTurn(current, "request", "Review", 1000))).rejects.toThrow("transcript");
    expect(store.useChats.getState().byTerminal.a).toBeUndefined();
  });

  it("removes only the deleted terminal's transcript from the next backup", async () => {
    const saved: Record<string, string> = { "chat.terminal.a": JSON.stringify(createChat()), "chat.terminal.b": JSON.stringify(createChat()) };
    store.useChats.getState().load(saved);
    boundary.writePref.mockImplementation(async (key, value) => { saved[key] = value; });
    await store.useChats.getState().drop(["a"]);
    store.useChats.getState().load(saved);
    expect(store.useChats.getState().byTerminal.a).toBeUndefined();
    expect(store.useChats.getState().byTerminal.b).toEqual(createChat());
  });
});

/**
 * The draft used to live inside the transcript document, so every pause in
 * typing (250 ms) rewrote the whole conversation to SQLite. Each topic's
 * draft now has a small row of its own; the transcript is written only when
 * the conversation itself changes. The draft row is written after the
 * transcript, so a crash in between can at worst offer a sent message again
 * as a draft, never lose one.
 */
describe("chat drafts", () => {
  it("typing a draft writes only the draft row, never the transcript", async () => {
    const document = beginTurn(createChat(), "request", "Review", 1000);
    store.useChats.getState().load({ "chat.terminal.a": JSON.stringify(document) });
    await store.useChats.getState().setDraft("a", 1, "hello");
    expect(boundary.writePref.mock.calls).toEqual([["chat.draft.a.1", "hello"]]);
    expect(store.useChats.getState().byTerminal.a.threads[1].draft).toBe("hello");
    expect(store.useChats.getState().byTerminal.a.threads[0].messages).toEqual(document.threads[0].messages);
  });

  it("brings a saved draft back over the transcript's older copy after a relaunch", () => {
    const document = createChat();
    document.threads[0].draft = "older";
    store.useChats.getState().load({ "chat.terminal.a": JSON.stringify(document), "chat.draft.a.0": "newer", "chat.draft.b.2": "orphan" });
    expect(store.useChats.getState().byTerminal.a.threads[0].draft).toBe("newer");
    expect(store.useChats.getState().byTerminal.b.threads[2].draft).toBe("orphan");
  });

  it("sending clears the draft row too, after the transcript, so a relaunch does not offer the sent text again", async () => {
    const saved: Record<string, string> = { "chat.terminal.a": JSON.stringify(createChat()), "chat.draft.a.0": "Review" };
    store.useChats.getState().load(saved);
    const order: string[] = [];
    boundary.writePref.mockImplementation(async (key, value) => { order.push(key); saved[key] = value; });
    await store.useChats.getState().update("a", (current) => beginTurn(current, "request", "Review", 1000));
    expect(order).toEqual(["chat.terminal.a", "chat.draft.a.0"]);
    store.useChats.getState().load(saved);
    expect(store.useChats.getState().byTerminal.a.threads[0].draft).toBe("");
    expect(store.useChats.getState().byTerminal.a.threads[0].messages.map((m) => m.text)).toEqual(["Review"]);
  });

  it("removing the terminal also removes its drafts", async () => {
    const saved: Record<string, string> = { "chat.terminal.a": JSON.stringify(createChat()), "chat.draft.a.3": "half a thought" };
    store.useChats.getState().load(saved);
    boundary.writePref.mockImplementation(async (key, value) => { saved[key] = value; });
    await store.useChats.getState().drop(["a"]);
    store.useChats.getState().load(saved);
    expect(store.useChats.getState().byTerminal.a).toBeUndefined();
  });
});
