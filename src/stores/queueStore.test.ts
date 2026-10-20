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
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dueItems, QUEUE_CAP } from "../lib/queue";
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
  useQueue.setState({ items: [], error: null });
});

it("reports a failed background queue edit instead of silently accepting it", async () => {
  await useQueue.getState().enqueue("t1", "Keep the durable request", "user");
  restore?.();
  restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Queue save refused"); } });
  useQueue.getState().clear("t1");
  await vi.waitFor(() => expect(useQueue.getState().error).toBe("Queue save refused"));
});

describe("enqueue", () => {
  it("reports a refused durable save without accepting or displaying the prompt", async () => {
    restore?.();
    restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Disk full"); } });
    expect(await useQueue.getState().enqueue("t1", "Keep this request", "user")).toEqual({ ok: false, reason: "failed" });
    expect(useQueue.getState().items).toEqual([]);
    expect(useQueue.getState().error).toBe("Disk full");
  });
  it("accepts and publishes a prompt only after native persistence acknowledges it", async () => {
    let finish!: () => void;
    restore?.();
    restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
      patchQueue: async (_before, after) => new Promise((resolve) => { finish = () => resolve([...after]); }) });
    const accepting = useQueue.getState().enqueue("t1", "Durable request", "user");
    expect(useQueue.getState().items).toEqual([]);
    finish();
    expect(await accepting).toEqual({ ok: true, position: 1 });
    expect(useQueue.getState().listFor("t1").map((item) => item.text)).toEqual(["Durable request"]);
  });
  it("preserves a previously unseen native task when acknowledging a locally queued prompt", async () => {
    const native = { id: "native-task", terminalId: "t2", taskId: "task-1", text: "Native request", at: 1000, source: "user" as const };
    let received: unknown;
    restore?.();
    restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
      patchQueue: async (before, after) => { received = { before, after }; return [native, ...after]; } });
    await useQueue.getState().enqueue("t1", "Local request", "user");
    await vi.waitFor(() => expect(useQueue.getState().items.some((item) => item.id === native.id)).toBe(true));
    expect(useQueue.getState().listFor("t2")).toEqual([native]);
    expect(useQueue.getState().listFor("t1").map((item) => item.text)).toEqual(["Local request"]);
    expect(received).toMatchObject({ before: [], after: [{ terminalId: "t1", text: "Local request" }] });
  });
  it("parks a prompt for a terminal and says where it landed", async () => {
    const at = await useQueue.getState().enqueue("t1", "rodar os testes", "user");
    expect(at).toEqual({ ok: true, position: 1 });
    expect(useQueue.getState().items).toHaveLength(1);
  });

  it("counts the position from the terminal's own queue", async () => {
    await useQueue.getState().enqueue("t1", "um", "user");
    await useQueue.getState().enqueue("t2", "outro terminal", "user");
    expect(await useQueue.getState().enqueue("t1", "dois", "user")).toEqual({
      ok: true,
      position: 2,
    });
  });

  it("refuses once the terminal's queue is full, and says so", async () => {
    for (let i = 0; i < QUEUE_CAP; i++) {
      await useQueue.getState().enqueue("t1", `p${i}`, "bridge");
    }
    const answer = await useQueue.getState().enqueue("t1", "mais um", "bridge");
    expect(answer.ok).toBe(false);
    expect(useQueue.getState().count("t1")).toBe(QUEUE_CAP);
  });

  it("refuses empty text instead of typing a bare Enter into a CLI", async () => {
    expect((await useQueue.getState().enqueue("t1", "   ", "user")).ok).toBe(false);
    expect(useQueue.getState().items).toHaveLength(0);
  });

  it("writes the queue to the kv, so a reload does not lose it", async () => {
    await useQueue.getState().enqueue("t1", "rodar os testes", "user");
    expect(JSON.parse(written[KV_QUEUE])).toHaveLength(1);
  });
});

describe("take", () => {
  /**
   * The regression this locks down: two effects racing (a runtime tick and a
   * store subscription) both saw the same head item and typed it in twice.
   * Taking is what removes it, and it is atomic.
   */
  it("hands the item over and removes it in the same move", async () => {
    await useQueue.getState().enqueue("t1", "primeiro", "user");
    const taken = useQueue.getState().take("t1");
    expect(taken?.text).toBe("primeiro");
    expect(useQueue.getState().take("t1")).toBeNull();
  });

  it("hands over the head, not the newest", async () => {
    await useQueue.getState().enqueue("t1", "primeiro", "user");
    await useQueue.getState().enqueue("t1", "segundo", "user");
    expect(useQueue.getState().take("t1")?.text).toBe("primeiro");
  });

  it("answers with nothing for a terminal with an empty queue", () => {
    expect(useQueue.getState().take("vazio")).toBeNull();
  });
});

describe("clearing", () => {
  it("keeps a reviewed prompt visible until native removal is acknowledged", async () => {
    const request = { id: "request", terminalId: "t1", text: "Keep the request", at: 1000, source: "user" as const,
      delivery: { status: "uncertain" as const, attemptedAt: 2000 } };
    useQueue.setState({ items: [request] });
    let finish!: () => void;
    let received: unknown;
    restore?.();
    restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
      removeQueue: async (id, attemptedAt) => { received = { id, attemptedAt }; return new Promise((resolve) => { finish = () => resolve([]); }); } });
    const removing = useQueue.getState().cancel(request.id);
    expect(useQueue.getState().items).toEqual([request]);
    finish();
    expect(await removing).toBe(true);
    expect(useQueue.getState().items).toEqual([]);
    expect(received).toEqual({ id: request.id, attemptedAt: 2000 });
  });
  it("retains an uncertain attempt until native review acknowledges a fresh retry identity", async () => {
    const original = { id: "old-attempt", terminalId: "t1", text: "Keep the request", at: 1000, source: "user" as const,
      delivery: { status: "uncertain" as const, attemptedAt: 2000 } };
    const fresh = { id: "new-attempt", terminalId: "t1", text: original.text, at: original.at, source: original.source };
    useQueue.setState({ items: [original] });
    let finish!: () => void;
    let received: unknown;
    restore?.();
    restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
      retryQueue: async (id, newId, attemptedAt) => { received = { id, newId, attemptedAt }; return new Promise((resolve) => { finish = () => resolve([fresh]); }); } });
    const reviewing = useQueue.getState().retry(original.id, fresh.id);
    expect(useQueue.getState().items).toEqual([original]);
    finish();
    expect(await reviewing).toBe(true);
    expect(useQueue.getState().items).toEqual([fresh]);
    expect(received).toEqual({ id: original.id, newId: fresh.id, attemptedAt: 2000 });
  });
  it("releases a reviewed uncertain prompt only when the user explicitly retries it", async () => {
    useQueue.getState().hydrate({ [KV_QUEUE]: JSON.stringify([{ id: "request", terminalId: "t1", text: "Review login", at: 1_000, source: "user", delivery: { status: "uncertain", attemptedAt: 2_000, error: "The terminal closed" } }]) });
    expect(dueItems(useQueue.getState().items, () => true)).toEqual([]);
    await useQueue.getState().retry("request", "reviewed-retry");
    expect(dueItems(useQueue.getState().items, () => true).map((item) => item.id)).toEqual(["reviewed-retry"]);
    expect(useQueue.getState().items[0].text).toBe("Review login");
    expect(JSON.parse(written[KV_QUEUE])[0].delivery).toBeUndefined();
  });
  it("drops one item by id", async () => {
    await useQueue.getState().enqueue("t1", "um", "user");
    const [only] = useQueue.getState().items;
    await useQueue.getState().cancel(only.id);
    expect(useQueue.getState().items).toHaveLength(0);
  });

  it("drops a whole terminal's queue when its card goes away", async () => {
    await useQueue.getState().enqueue("t1", "um", "user");
    await useQueue.getState().enqueue("t1", "dois", "user");
    await useQueue.getState().enqueue("t2", "outro", "user");
    useQueue.getState().clear("t1");
    expect(useQueue.getState().items.map((i) => i.terminalId)).toEqual(["t2"]);
  });

  it("prunes what belongs to terminals that no longer exist", async () => {
    await useQueue.getState().enqueue("t1", "um", "user");
    await useQueue.getState().enqueue("fantasma", "dois", "user");
    useQueue.getState().prune((id) => id === "t1");
    expect(useQueue.getState().items).toHaveLength(1);
  });

  /** A prune that changes nothing must not schedule a write. */
  it("does not touch the kv when there was nothing to prune", async () => {
    await useQueue.getState().enqueue("t1", "um", "user");
    written = {};
    useQueue.getState().prune(() => true);
    expect(written[KV_QUEUE]).toBeUndefined();
  });
});

describe("hydrate", () => {
  it("restores an interrupted delivery for review instead of submitting the prompt again", () => {
    useQueue.getState().hydrate({
      [KV_QUEUE]: JSON.stringify([{ id: "request", terminalId: "t1", text: "Review login", at: 1_000, source: "user", delivery: { status: "sending", attemptedAt: 2_000 } }]),
    });
    expect(useQueue.getState().listFor("t1")[0].delivery).toEqual({
      status: "uncertain", attemptedAt: 2_000,
      error: "A entrega foi interrompida antes da confirmação. Confira o terminal antes de reenviar.",
    });
  });
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
