/**
 * The page's half of the PTY channel (`src-tauri/src/pty/pages.rs`).
 *
 * Every listener here used to get its payload straight off the event bus.
 * What these tests hold is that it still gets the same payload, to the
 * character and in the same order, and that nothing one listener does can
 * stall the others: one channel carries every terminal on the page, and a
 * message that never finishes being delivered holds back all that follow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPtyStream, type PtyPort, type PtyTopic } from "./ptyStream";

/** Everything a terminal paints that JSON escapes, and characters of every width. */
const AWKWARD = "ação 😀 € \x1b[1;32mverde\x1b[0m \0\x07\t\"\\\r\n﻿";

/**
 * What `pages.rs` sends for a chunk of 1 KiB or more: the text's bytes, a
 * JSON trailer with the subscriptions and the terminal id, and the trailer's
 * length as a little-endian u32.
 */
function raw(to: number[], id: string, data: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const text = encoder.encode(data);
  const trailer = encoder.encode(JSON.stringify({ to, id }));
  const out = new Uint8Array(text.length + trailer.length + 4);
  out.set(text, 0);
  out.set(trailer, text.length);
  new DataView(out.buffer).setUint32(text.length + trailer.length, trailer.length, true);
  return out.buffer;
}

const topicName = (t: PtyTopic) => (t.kind === "idle" ? "idle" : `${t.kind} ${t.id}`);

/**
 * A backend at the process boundary: records what the page asked of it, and
 * lets a test send messages the way `pages.rs` addresses them.
 */
function fakeBackend() {
  let deliver: ((message: unknown) => void) | null = null;
  const calls: string[] = [];
  /** What the page answered for, apart: the bookkeeping tests read `calls` whole. */
  const acks: string[] = [];
  const subs = new Map<number, PtyTopic>();
  const port: PtyPort = {
    open: async (d) => {
      deliver = d;
      calls.push("open");
      return 7;
    },
    subscribe: async (link, sub, topic) => {
      subs.set(sub, topic);
      calls.push(`subscribe ${link} ${sub} ${topicName(topic)}`);
    },
    unsubscribe: async (link, sub) => {
      subs.delete(sub);
      calls.push(`unsubscribe ${link} ${sub}`);
    },
    ack: async (id, chunks) => {
      acks.push(`${id} ${chunks}`);
    },
  };
  /** The subscriptions the backend holds for a topic, as `to` lists them. */
  const to = (name: string) =>
    [...subs]
      .filter(([, topic]) => topicName(topic) === name)
      .map(([sub]) => sub)
      .sort((a, b) => a - b);
  const send = (message: unknown) => {
    if (!deliver) throw new Error("the page link was never opened");
    deliver(message);
  };
  return { port, calls, acks, to, send };
}

describe("ptyStream", () => {
  it("a chunk under a kibibyte reaches its terminal's listener as the text it was sent as", async () => {
    const { port, send, to } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    const got: unknown[] = [];
    await stream.output("t1", (p) => got.push(p));

    send({ to: to("output t1"), output: { id: "t1", data: AWKWARD } });

    expect(got).toEqual([{ data: AWKWARD }]);
  });

  it("a raw chunk is the text whose bytes it carries", async () => {
    const { port, send, to } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    const got: unknown[] = [];
    await stream.output("térm-1", (p) => got.push(p));

    const data = AWKWARD.repeat(40);
    send(raw(to("output térm-1"), "térm-1", data));

    expect(got).toEqual([{ data }]);
  });

  // A `TextDecoder` swallows a byte-order mark at the start of what it decodes
  // unless told not to. The JSON string on the bus kept it, and a terminal can
  // print one (a UTF-8 file with a BOM, `type`d).
  it("a chunk that starts with a byte-order mark keeps it", async () => {
    const { port, send, to } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    const got: unknown[] = [];
    await stream.output("t1", (p) => got.push(p));

    const data = "﻿" + AWKWARD.repeat(40);
    send(raw(to("output t1"), "t1", data));

    expect(got).toEqual([{ data }]);
  });

  // The engine sends at most `INFLIGHT_CAP` (8) chunks a page has not
  // answered for (`reader.rs`), and each answer is a sync command on the UI
  // thread that takes the global ptys lock. One per chunk was about sixty a
  // second for every visible terminal streaming. The page answers in batches
  // instead: never more than a few chunks owed, never left owed for long,
  // or the pump would hold that terminal's output at the cap.
  describe("acknowledgements", () => {
    /** The longest a chunk may wait for its acknowledgement. */
    const ACK_DEADLINE_MS = 32;

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // What the page answers for is what it took off the channel, listener or
    // none. A chunk whose view unmounted while it was on its way was still
    // queued and drained, and the bridge's memory is what the count bounds,
    // not what got painted.
    it("every output chunk taken off the channel is acknowledged to its terminal, listener or not", async () => {
      const { port, send, to, acks } = fakeBackend();
      const stream = createPtyStream(port, () => {});
      const off = await stream.output("t1", () => {});
      await stream.exit("t2", () => {});

      send({ to: to("output t1"), output: { id: "t1", data: "um" } });
      send(raw(to("output t1"), "t1", "dois".repeat(300)));
      off();
      send({ to: [1], output: { id: "t1", data: "tres, para a view que se foi" } });
      send({ to: to("exit t2"), exit: { id: "t2", code: 0, reason: "exited" } });
      vi.advanceTimersByTime(ACK_DEADLINE_MS);

      expect(acks).toEqual(["t1 3"]);
    });

    it("a terminal streaming fast is answered every four chunks, well inside the engine's cap of eight", async () => {
      const { port, send, to, acks } = fakeBackend();
      const stream = createPtyStream(port, () => {});
      await stream.output("t1", () => {});

      for (const data of ["um", "dois", "tres", "quatro"]) {
        send({ to: to("output t1"), output: { id: "t1", data } });
      }

      expect(acks).toEqual(["t1 4"]);
    });

    // The regression this locks down: a batch that only goes out once it is
    // full would leave the last chunks of a burst owed for good, and the
    // engine would hold that terminal's next output until its grace ran out.
    it("chunks short of a batch are answered once output stops, within the deadline", async () => {
      const { port, send, to, acks } = fakeBackend();
      const stream = createPtyStream(port, () => {});
      await stream.output("t1", () => {});

      for (const data of ["um", "dois", "tres", "quatro", "cinco"]) {
        send({ to: to("output t1"), output: { id: "t1", data } });
      }
      vi.advanceTimersByTime(ACK_DEADLINE_MS);

      expect(acks).toEqual(["t1 4", "t1 1"]);
    });

    it("each terminal is answered for its own chunks, not its neighbour's", async () => {
      const { port, send, to, acks } = fakeBackend();
      const stream = createPtyStream(port, () => {});
      await stream.output("t1", () => {});
      await stream.output("t2", () => {});

      send({ to: to("output t1"), output: { id: "t1", data: "um" } });
      send(raw(to("output t2"), "t2", "dois".repeat(300)));
      send({ to: to("output t1"), output: { id: "t1", data: "tres" } });
      vi.advanceTimersByTime(ACK_DEADLINE_MS);

      expect([...acks].sort()).toEqual(["t1 2", "t2 1"]);
    });

    it("a page with nothing left to answer for keeps no timer waiting", async () => {
      const { port, send, to } = fakeBackend();
      const stream = createPtyStream(port, () => {});
      await stream.output("t1", () => {});

      for (const data of ["um", "dois", "tres", "quatro"]) {
        send({ to: to("output t1"), output: { id: "t1", data } });
      }

      expect(vi.getTimerCount()).toBe(0);
    });

    it("an acknowledgement the backend refuses is reported", async () => {
      const backend = fakeBackend();
      const refused = new Error("sem terminal");
      const port: PtyPort = { ...backend.port, ack: () => Promise.reject(refused) };
      const errors: unknown[] = [];
      const stream = createPtyStream(port, (e) => errors.push(e));
      await stream.output("t1", () => {});

      backend.send({ to: backend.to("output t1"), output: { id: "t1", data: "um" } });
      await vi.advanceTimersByTimeAsync(ACK_DEADLINE_MS);

      expect(errors).toEqual([refused]);
    });
  });

  it("output reaches only the listeners of the terminal that wrote it", async () => {
    const { port, send, to } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    const one: unknown[] = [];
    const two: unknown[] = [];
    await stream.output("t1", (p) => one.push(p.data));
    await stream.output("t2", (p) => two.push(p.data));

    send({ to: to("output t1"), output: { id: "t1", data: "um" } });
    send(raw(to("output t2"), "t2", "dois".repeat(300)));

    expect(one).toEqual(["um"]);
    expect(two).toEqual(["dois".repeat(300)]);
  });

  it("exit and heartbeat reach that terminal's listeners, idle every idle listener, each payload as sent", async () => {
    const { port, send, to } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    const got: unknown[] = [];
    await stream.exit("t1", (p) => got.push(["exit t1", p]));
    await stream.activity("t1", (p) => got.push(["activity t1", p]));
    await stream.exit("t2", (p) => got.push(["exit t2", p]));
    await stream.idle((p) => got.push(["idle", p]));

    const exit = { id: "t1", code: null, reason: "killed" };
    const beat = { id: "t1", lastByteAt: 1_700_000_000_123, idleMs: 450 };
    const idle = { id: "t9", title: "claude: ação", idleMs: 4_600 };
    send({ to: to("exit t1"), exit });
    send({ to: to("activity t1"), activity: beat });
    send({ to: to("idle"), idle });

    expect(got).toEqual([
      ["exit t1", exit],
      ["activity t1", beat],
      ["idle", idle],
    ]);
  });

  // The bus fixed an event's listeners when Rust emitted it. A view mounting
  // in place of another (a layout switch while the CLI streams) must not get
  // the chunk that was on its way to the old view: its own attach snapshot
  // already holds those bytes, and painting them again doubles them.
  it("a message reaches the subscriptions it was addressed to, not one made while it was on its way", async () => {
    const { port, send, to } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    const old: string[] = [];
    const fresh: string[] = [];
    const stopOld = await stream.output("t1", (p) => old.push(p.data));
    const inFlight = { to: to("output t1"), output: { id: "t1", data: "para a antiga" } };
    const inFlightRaw = raw(to("output t1"), "t1", "tambem".repeat(300));

    stopOld();
    await stream.output("t1", (p) => fresh.push(p.data));
    send(inFlight);
    send(inFlightRaw);
    send({ to: to("output t1"), output: { id: "t1", data: "para a nova" } });

    expect(old).toEqual([]);
    expect(fresh).toEqual(["para a nova"]);
  });

  it("each subscription asks the backend for its own topic once the page link is open", async () => {
    const { port, calls } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    await stream.output("t1", () => {});
    await stream.exit("t1", () => {});
    await stream.activity("t2", () => {});
    await stream.idle(() => {});

    expect(calls).toEqual([
      "open",
      "subscribe 7 1 output t1",
      "subscribe 7 2 exit t1",
      "subscribe 7 3 activity t2",
      "subscribe 7 4 idle",
    ]);
  });

  it("unlistening stops that listener at once and releases its own subscription, once", async () => {
    const { port, calls, send, to } = fakeBackend();
    const stream = createPtyStream(port, () => {});
    const gone: string[] = [];
    const kept: string[] = [];
    const stop = await stream.output("t1", (p) => gone.push(p.data));
    await stream.output("t1", (p) => kept.push(p.data));
    const stopExit = await stream.exit("t1", (p) => gone.push(p.reason));
    // Addressed while all three still held, delivered after they let go.
    const late = { to: to("output t1"), output: { id: "t1", data: "depois" } };
    const lateExit = { to: to("exit t1"), exit: { id: "t1", code: 0, reason: "normal" } };

    stop();
    stop();
    stopExit();
    send(late);
    send(lateExit);

    expect(gone).toEqual([]);
    expect(kept).toEqual(["depois"]);
    expect(calls.slice(4)).toEqual(["unsubscribe 7 1", "unsubscribe 7 3"]);
  });

  // `XTermView` attaches only once its subscription resolves, and the backend
  // may send the moment it registers, before its answer lands: the listener
  // has to be there already, as `listen`'s callback was.
  it("a subscription resolves once the backend holds it, and hears what arrives before that answer", async () => {
    const backend = fakeBackend();
    let answer!: () => void;
    const port: PtyPort = {
      ...backend.port,
      subscribe: async (link, sub, topic) => {
        await backend.port.subscribe(link, sub, topic);
        await new Promise<void>((resolve) => (answer = resolve));
      },
    };
    const stream = createPtyStream(port, () => {});
    const got: string[] = [];
    let resolved = false;
    const subscribing = stream.output("t1", (p) => got.push(p.data)).then(() => (resolved = true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    backend.send({ to: backend.to("output t1"), output: { id: "t1", data: "cedo" } });
    expect(resolved).toBe(false);
    answer();
    await subscribing;

    expect(got).toEqual(["cedo"]);
    expect(resolved).toBe(true);
  });

  // One page link serves every subscription, so a failure to open it must not
  // stick: each `listen` used to stand on its own, and one that failed did not
  // take the next ones down with it.
  it("a failed open rejects that subscription, leaves no listener behind, and the next one opens again", async () => {
    const backend = fakeBackend();
    let failures = 1;
    const port: PtyPort = {
      ...backend.port,
      open: (d) => (failures-- > 0 ? Promise.reject(new Error("sem canal")) : backend.port.open(d)),
    };
    const stream = createPtyStream(port, () => {});
    const got: string[] = [];

    await expect(stream.output("t1", (p) => got.push(`falhou ${p.data}`))).rejects.toThrow("sem canal");
    await stream.output("t1", (p) => got.push(p.data));
    backend.send({ to: [1, 2], output: { id: "t1", data: "oi" } });

    expect(got).toEqual(["oi"]);
    expect(backend.calls).toEqual(["open", "subscribe 7 2 output t1"]);
  });

  // Tauri's channel counts a message as delivered only once its handler
  // returns. A throw escaping from here would leave that message undelivered,
  // and every message after it, for every terminal on the page, waiting behind
  // it for good. On the bus a throw only cost its own event.
  it("a listener that throws stops neither the other listeners nor the next message, and is reported", async () => {
    const { port, send, to } = fakeBackend();
    const errors: unknown[] = [];
    const stream = createPtyStream(port, (e) => errors.push(e));
    const got: string[] = [];
    const boom = new Error("boom");
    await stream.output("t1", () => {
      throw boom;
    });
    await stream.output("t1", (p) => got.push(p.data));
    await stream.exit("t1", (p) => got.push(p.reason));

    send({ to: to("output t1"), output: { id: "t1", data: "um" } });
    send({ to: to("exit t1"), exit: { id: "t1", code: 0, reason: "normal" } });

    expect(got).toEqual(["um", "normal"]);
    expect(errors).toEqual([boom]);
  });

  // Same reason as above: a message this side cannot read must not throw out
  // of the channel's handler either.
  it("a message it cannot read is dropped, reported, and the next one still arrives", async () => {
    const { port, send, to } = fakeBackend();
    const errors: unknown[] = [];
    const stream = createPtyStream(port, (e) => errors.push(e));
    const got: string[] = [];
    await stream.output("t1", (p) => got.push(p.data));

    const lying = new Uint8Array([1, 2, 3, 200, 0, 0, 0]).buffer; // a trailer longer than the buffer
    const badTrailer = new Uint8Array([...new TextEncoder().encode("oi{x"), 2, 0, 0, 0]).buffer;
    const unreadable = [
      new ArrayBuffer(3),
      lying,
      badTrailer,
      null,
      "texto",
      42,
      {},
      { to: [1] },
      { to: "1", output: { id: "t1", data: "x" } },
      { to: [1], output: null },
      { to: [1], exit: {} },
    ];
    for (const bad of unreadable) {
      expect(() => send(bad)).not.toThrow();
    }
    send({ to: to("output t1"), output: { id: "t1", data: "ok" } });

    expect(got).toEqual(["ok"]);
    expect(errors).toHaveLength(unreadable.length);
  });
});
