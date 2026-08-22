/**
 * The two decisions behind the "Ao Vivo" overlay that are easy to get wrong
 * and impossible to notice in code review:
 *
 * - **which trail to follow.** Sessions are listed per folder, so two CLIs in
 *   the same project take turns at being "the most recent" — following that
 *   made the overlay hop to the neighbour's conversation and throw away
 *   everything it had reduced.
 * - **what an empty plan means.** Clearing the todo list is how a CLI says
 *   "done", and taking it literally emptied the board exactly then.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession, FeedEvent, TerminalRow } from "../lib/ipc";

const listAgentSessions = vi.fn(async (): Promise<AgentSession[]> => []);
const sessionTailStart = vi.fn(async () => {});
const sessionTailStop = vi.fn(async () => {});
/** The `agents://changed` handler the store installs. */
let onChanged: (() => void) | null = null;

vi.mock("../lib/ipc", () => ({
  ipc: {
    listAgentSessions: (...a: unknown[]) => listAgentSessions(...(a as [])),
    sessionTailStart: (...a: unknown[]) => sessionTailStart(...(a as [])),
    sessionTailStop: (...a: unknown[]) => sessionTailStop(...(a as [])),
  },
  on: {
    sessionFeed: async () => () => {},
    agentsChanged: async (cb: () => void) => {
      onChanged = cb;
      return () => {};
    },
  },
}));

const { applyFeed, useLive } = await import("./liveStore");

const TERM: TerminalRow = {
  id: "t1",
  groupId: "g1",
  slot: 0,
  title: "Claude",
  kind: "agent",
  agentId: "claude",
  program: "claude",
  args: [],
  cwd: "C:\\proj",
  sort: 0,
  alive: true,
  createdAt: 0,
};

function session(id: string, updatedAt: number): AgentSession {
  return {
    agent: "claude",
    externalId: id,
    projectPath: "C:\\proj",
    title: id,
    updatedAt,
    sizeBytes: 10,
    file: `C:\\sessions\\${id}.jsonl`,
  };
}

/** Newest first, as the backend delivers them. */
function ondisk(...s: AgentSession[]) {
  listAgentSessions.mockResolvedValue(
    [...s].sort((a, b) => b.updatedAt - a.updatedAt),
  );
}

function tool(op: string, patch: Partial<FeedEvent> = {}): FeedEvent {
  return { kind: "tool", at: 1, op, tool: "TodoWrite", ...patch } as FeedEvent;
}

beforeEach(() => {
  useLive.getState().close();
  listAgentSessions.mockReset();
  sessionTailStart.mockReset();
  sessionTailStop.mockReset();
  // `onChanged` is deliberately *not* cleared: the store installs its
  // listeners once for the whole module's life, so only the first `openFor`
  // hands it over.
});

describe("which session to follow", () => {
  it("does not switch trails just because the neighbour wrote later", async () => {
    const mine = session("mine", 100);
    const neighbour = session("neighbour", 90);
    ondisk(mine, neighbour);

    await useLive.getState().openFor(TERM);
    expect(useLive.getState().session?.externalId).toBe("mine");

    // The neighbour gets a turn and becomes the most recent one in the directory.
    ondisk(mine, session("neighbour", 200));
    onChanged?.();
    await vi.waitFor(() =>
      expect(useLive.getState().sessions[0].externalId).toBe("neighbour"),
    );
    expect(useLive.getState().session?.externalId).toBe("mine");
    expect(sessionTailStart).toHaveBeenCalledTimes(1);

    useLive.getState().close();
  });

  it("follows a conversation born afterwards (the CLI's `/clear`)", async () => {
    ondisk(session("velha", 100));
    await useLive.getState().openFor(TERM);
    expect(useLive.getState().session?.externalId).toBe("velha");

    ondisk(session("velha", 100), session("nova", 300));
    onChanged?.();
    await vi.waitFor(() =>
      expect(useLive.getState().session?.externalId).toBe("nova"),
    );

    useLive.getState().close();
  });

  it("a resumed terminal starts on the session it resumed", async () => {
    ondisk(session("vizinha", 500), session("retomada", 10));
    await useLive
      .getState()
      .openFor({ ...TERM, resume: ["--resume", "retomada"] });
    expect(useLive.getState().session?.externalId).toBe("retomada");

    useLive.getState().close();
  });

  it("waits for the first session to appear when there is none", async () => {
    ondisk();
    await useLive.getState().openFor(TERM);
    expect(useLive.getState().phase).toBe("none");

    ondisk(session("primeira", 10));
    onChanged?.();
    await vi.waitFor(() =>
      expect(useLive.getState().session?.externalId).toBe("primeira"),
    );

    useLive.getState().close();
  });
});

describe("the agent's plan", () => {
  const feed = (events: FeedEvent[]) => ({
    tailId: "t1",
    reset: false,
    live: true,
    events,
  });

  it("keeps the last plan when the CLI clears the list", () => {
    applyFeed(
      feed([
        tool("todo", {
          todos: [
            { content: "achar o bug", status: "completed" },
            { content: "corrigir", status: "completed" },
          ],
        }),
      ]),
    );
    expect(useLive.getState().todos).toHaveLength(2);

    applyFeed(feed([tool("todo", { todos: [] })]));
    expect(useLive.getState().todos).toHaveLength(2);
  });

  it("switches plans when a real new one arrives", () => {
    applyFeed(feed([tool("todo", { todos: [{ content: "a", status: "pending" }] })]));
    applyFeed(
      feed([
        tool("todo", {
          todos: [
            { content: "b", status: "in_progress" },
            { content: "c", status: "pending" },
          ],
        }),
      ]),
    );
    expect(useLive.getState().todos.map((t) => t.content)).toEqual(["b", "c"]);
  });
});
