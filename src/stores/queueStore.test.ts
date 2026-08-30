/**
 * The store is what makes a queued prompt survive the thing that kills every
 * other in-memory plan in this app: a reload. Yard reloads on HMR, on F5 and
 * on a restored backup, and the PTYs live in Rust and do not care — so a
 * queue held only in a React store would quietly drop three prompts the user
 * had already stopped thinking about.
 *
 * It also owns the two rules a queue cannot get wrong: an item is handed out
 * once (never twice, however many effects fire), and a queue whose terminal
 * is gone goes with it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { QUEUE_CAP } from "../lib/queue";
import { setPrefsTransport } from "../lib/prefs";
import { KV_QUEUE, useQueue } from "./queueStore";

let written: Record<string, string>;
let restore: (() => void) | undefined;

beforeEach(() => {
  written = {};
  restore?.();
  restore = setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      written[key] = value;
    },
  });
  useQueue.setState({ items: [] });
});

describe("enqueue", () => {
  it("parks a prompt for a terminal and says where it landed", () => {
    const at = useQueue.getState().enqueue("t1", "rodar os testes", "user");
    expect(at).toEqual({ ok: true, position: 1 });
    expect(useQueue.getState().items).toHaveLength(1);
  });

  it("counts the position from the terminal's own queue", () => {
    useQueue.getState().enqueue("t1", "um", "user");
    useQueue.getState().enqueue("t2", "outro terminal", "user");
    expect(useQueue.getState().enqueue("t1", "dois", "user")).toEqual({
      ok: true,
      position: 2,
    });
  });

  it("refuses once the terminal's queue is full, and says so", () => {
    for (let i = 0; i < QUEUE_CAP; i++) {
      useQueue.getState().enqueue("t1", `p${i}`, "bridge");
    }
    const answer = useQueue.getState().enqueue("t1", "mais um", "bridge");
    expect(answer.ok).toBe(false);
    expect(useQueue.getState().count("t1")).toBe(QUEUE_CAP);
  });

  it("refuses empty text instead of typing a bare Enter into a CLI", () => {
    expect(useQueue.getState().enqueue("t1", "   ", "user").ok).toBe(false);
    expect(useQueue.getState().items).toHaveLength(0);
  });

  it("writes the queue to the kv, so a reload does not lose it", () => {
    useQueue.getState().enqueue("t1", "rodar os testes", "user");
    expect(JSON.parse(written[KV_QUEUE])).toHaveLength(1);
  });
});

describe("take", () => {
  /**
   * The regression this locks down: two effects racing (a runtime tick and a
   * store subscription) both saw the same head item and typed it in twice.
   * Taking is what removes it, and it is atomic.
   */
  it("hands the item over and removes it in the same move", () => {
    useQueue.getState().enqueue("t1", "primeiro", "user");
    const taken = useQueue.getState().take("t1");
    expect(taken?.text).toBe("primeiro");
    expect(useQueue.getState().take("t1")).toBeNull();
  });

  it("hands over the head, not the newest", () => {
    useQueue.getState().enqueue("t1", "primeiro", "user");
    useQueue.getState().enqueue("t1", "segundo", "user");
    expect(useQueue.getState().take("t1")?.text).toBe("primeiro");
  });

  it("answers with nothing for a terminal with an empty queue", () => {
    expect(useQueue.getState().take("vazio")).toBeNull();
  });
});

describe("clearing", () => {
  it("drops one item by id", () => {
    useQueue.getState().enqueue("t1", "um", "user");
    const [only] = useQueue.getState().items;
    useQueue.getState().cancel(only.id);
    expect(useQueue.getState().items).toHaveLength(0);
  });

  it("drops a whole terminal's queue when its card goes away", () => {
    useQueue.getState().enqueue("t1", "um", "user");
    useQueue.getState().enqueue("t1", "dois", "user");
    useQueue.getState().enqueue("t2", "outro", "user");
    useQueue.getState().clear("t1");
    expect(useQueue.getState().items.map((i) => i.terminalId)).toEqual(["t2"]);
  });

  it("prunes what belongs to terminals that no longer exist", () => {
    useQueue.getState().enqueue("t1", "um", "user");
    useQueue.getState().enqueue("fantasma", "dois", "user");
    useQueue.getState().prune((id) => id === "t1");
    expect(useQueue.getState().items).toHaveLength(1);
  });

  /** A prune that changes nothing must not schedule a write. */
  it("does not touch the kv when there was nothing to prune", () => {
    useQueue.getState().enqueue("t1", "um", "user");
    written = {};
    useQueue.getState().prune(() => true);
    expect(written[KV_QUEUE]).toBeUndefined();
  });
});

describe("hydrate", () => {
  it("reads back what was written", () => {
    useQueue.getState().hydrate({
      [KV_QUEUE]: JSON.stringify([
        { id: "a", terminalId: "t1", text: "de antes", at: 1, source: "user" },
      ]),
    });
    expect(useQueue.getState().count("t1")).toBe(1);
  });

  it("survives junk on disk instead of taking the app down at boot", () => {
    useQueue.getState().hydrate({ [KV_QUEUE]: "{{{" });
    expect(useQueue.getState().items).toEqual([]);
  });
});
