/** Agent replies must be explicit and scoped to the terminal that owns the conversation. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  readPrefs: vi.fn(async () => ({})),
  writePref: vi.fn(async (_key: string, _value: string) => {}),
}));
vi.mock("./ipc", () => ({ ipc: boundary }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: vi.fn() }));
import { handleBridgeRequest } from "./bridge";
import { useChats } from "../stores/chatsStore";
import { useProjects } from "../stores/projectsStore";
import { beginTurn, createChat, replyToTurn } from "./chat";

beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
  boundary.writePref.mockReset().mockResolvedValue(undefined);
  useProjects.setState({ projects: [], groups: [], terminals: [], activeGroupId: null, activeProjectId: null });
  useChats.getState().load({});
});

function caller() {
  const groupId = useProjects.getState().addBoard("Workspace");
  return useProjects.getState().addTerminal({ groupId, title: "Agent", kind: "agent", program: "agent.exe", cwd: "C:/project" });
}

describe("yard chat", () => {
  it("delivers the agent's explicit Markdown reply to its own pending conversation", async () => {
    const id = caller();
    await useChats.getState().update(id, (document) => beginTurn(document, "turn-1", "Review", 1000));
    const result = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: id, argv: ["chat", "reply", "--thread", "1", "--turn", "turn-1", "**Ready**"] });
    expect(result.code).toBe(0);
    expect(useChats.getState().byTerminal[id].threads[0].messages.at(-1)?.text).toBe("**Ready**");
    expect(useChats.getState().byTerminal[id].pending).toBeUndefined();
  });

  it("reads the caller's selected topic without exposing another terminal's history", async () => {
    const id = caller();
    const other = caller();
    useChats.getState().load({
      [`chat.terminal.${id}`]: JSON.stringify(beginTurn(createChat(), "own", "Own request", 1000)),
      [`chat.terminal.${other}`]: JSON.stringify(beginTurn(createChat(), "private", "Private request", 1000)),
    });
    const result = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: id, argv: ["chat", "history", "--thread", "1"] });
    expect(result.code).toBe(0);
    expect(result.output).toContain("Own request");
    expect(result.output).not.toContain("Private request");
  });
});

/**
 * A topic keeps up to 500 messages, and `history` used to hand all of them to
 * the agent that asked, which pays to read every one. The default is the last
 * fifty, `--last N` asks for another number, and the answer says how many
 * older ones were left out so the agent knows the record is not complete.
 */
describe("yard chat history size", () => {
  /** A topic with `turns` request/answer pairs: twice as many messages. */
  function longTopic(id: string, turns: number) {
    let document = createChat();
    for (let i = 0; i < turns; i++) {
      document = beginTurn(document, `turn-${i}`, `pedido ${i}`, 1000 + i);
      document = replyToTurn(document, `turn-${i}`, 0, `resposta ${i}`, 2000 + i);
    }
    useChats.getState().load({ [`chat.terminal.${id}`]: JSON.stringify(document) });
  }

  it("hands back the last 50 messages by default and says how many older ones were omitted", async () => {
    const id = caller();
    longTopic(id, 40);

    const result = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: id, argv: ["chat", "history"] });

    const body = JSON.parse(result.output);
    expect(body.messages).toHaveLength(50);
    expect(body.messages.at(-1).text).toBe("resposta 39");
    expect(body.omitted).toBe(30);
  });

  it("--last asks for another number of the newest messages", async () => {
    const id = caller();
    longTopic(id, 40);

    const result = await handleBridgeRequest({ v: 1, cwd: "C:/project", terminal: id, argv: ["chat", "history", "--last", "4"] });

    const body = JSON.parse(result.output);
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(["pedido 38", "resposta 38", "pedido 39", "resposta 39"]);
    expect(body.omitted).toBe(76);
  });
});
