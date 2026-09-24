/**
 * The page's half of the PTY channel (`src-tauri/src/pty/pages.rs`).
 *
 * Everything a terminal says (output, exit, activity heartbeat, idle) arrives
 * on one ordered channel per page, instead of the event bus. This module turns
 * each message back into the payload the bus used to hand out, identical to
 * the character, and calls the listeners in the order the engine produced it.
 *
 * Free of Tauri on purpose: the channel, the subscribe and the unsubscribe
 * come in through `PtyPort`, so the whole contract is tested with plain
 * functions.
 */
import type { ActivityPayload, ExitPayload, IdlePayload, OutputChunk } from "./ipc";

/** What one subscription listens to, spelled as `Topic` in `pages.rs` reads it. */
export type PtyTopic =
  | { kind: "output" | "exit" | "activity"; id: string }
  | { kind: "idle" };

/** What the backend offers: the page's channel and the subscriptions on it. */
export interface PtyPort {
  /** Opens this page's channel; resolves with its link number once the backend holds it. */
  open: (deliver: (message: unknown) => void) => Promise<number>;
  subscribe: (link: number, sub: number, topic: PtyTopic) => Promise<void>;
  unsubscribe: (link: number, sub: number) => Promise<void>;
  /**
   * This page took `chunks` chunks of terminal `id`'s output off the channel.
   * The engine sends at most `INFLIGHT_CAP` (`reader.rs`) it has not been
   * told about: Tauri keeps every chunk sent until the page fetches it, with
   * no bound of its own, and a page busy for ten seconds under an agent
   * printing 20 MB/s used to leave 200 MB of them parked in the bridge.
   */
  ack: (id: string, chunks: number) => Promise<void>;
}

type Unlisten = () => void;

export interface PtyStream {
  output: (id: string, cb: (p: OutputChunk) => void) => Promise<Unlisten>;
  exit: (id: string, cb: (p: ExitPayload) => void) => Promise<Unlisten>;
  activity: (id: string, cb: (p: ActivityPayload) => void) => Promise<Unlisten>;
  idle: (cb: (p: IdlePayload) => void) => Promise<Unlisten>;
}

/** One message off the channel, as `pages.rs` shapes it: who it is for, and what it says. */
type Message = { to: number[] } & (
  | { output: { id: string; data: string } }
  | { exit: ExitPayload }
  | { activity: ActivityPayload }
  | { idle: IdlePayload }
);

/**
 * A chunk of 1 KiB or more comes as an `ArrayBuffer`: the text's bytes, then
 * a JSON trailer `{ to, id }`, then the trailer's length as a little-endian
 * u32 (`output_body` in `pages.rs`). Everything else is already JSON. `null`
 * for anything else: nothing here may throw (see `deliver`).
 */
function read(message: unknown, decoder: TextDecoder): Message | null {
  if (message instanceof ArrayBuffer) {
    const end = message.byteLength - 4;
    if (end < 0) return null;
    const trailerStart = end - new DataView(message).getUint32(end, true);
    if (trailerStart < 0) return null;
    let trailer: unknown;
    try {
      trailer = JSON.parse(decoder.decode(new Uint8Array(message, trailerStart, end - trailerStart)));
    } catch {
      return null;
    }
    if (!hasId(trailer) || !isTo((trailer as { to?: unknown }).to)) return null;
    const { to, id } = trailer as { to: number[]; id: string };
    return { to, output: { id, data: decoder.decode(new Uint8Array(message, 0, trailerStart)) } };
  }
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  if (!isTo(m.to)) return null;
  if (hasId(m.output)) {
    return typeof (m.output as { data?: unknown }).data === "string" ? (m as Message) : null;
  }
  if (hasId(m.exit) || hasId(m.activity) || hasId(m.idle)) return m as Message;
  return null;
}

function hasId(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function isTo(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((sub) => typeof sub === "number");
}

/**
 * Chunks of one terminal answered for in a single `ack`: half the engine's
 * `INFLIGHT_CAP` (`reader.rs`), so what the page sits on never gets near the
 * count at which the pump holds that terminal's output. Each `ack` is a sync
 * command on the UI thread that takes the global ptys lock: one per chunk
 * was about sixty a second for every visible terminal streaming.
 */
const ACK_BATCH = 4;
/**
 * The longest an owed chunk waits for its batch to fill, so a burst that
 * stops short of one is still answered. A timer, not an animation frame:
 * frames stop while the window is hidden, and the pump would then stall at
 * the cap with the page still taking chunks off the channel.
 */
const ACK_DELAY_MS = 32;

/** A live subscription: what kind of message it takes, and who to call. */
interface Entry {
  kind: PtyTopic["kind"];
  cb: (payload: never) => void;
}

export function createPtyStream(port: PtyPort, onError: (error: unknown) => void): PtyStream {
  /** Live subscriptions by the number this page gave them. */
  const entries = new Map<number, Entry>();
  let link: Promise<number> | null = null;
  let lastSub = 0;
  // `ignoreBOM`: keep a leading U+FEFF as text, as the JSON string did. Not
  // streaming, and one decoder for every terminal: each chunk is whole
  // characters (`emit_in_chunks` in `reader.rs` cuts on their boundaries, and
  // is a Rust `String`), so there is never a partial one to carry over.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  /** Chunks taken off the channel and not answered for yet, per terminal. */
  const owed = new Map<string, number>();
  /** The one timer that answers for whatever is still owed. */
  let answering: ReturnType<typeof setTimeout> | null = null;

  const answer = (id: string, chunks: number) => {
    void port.ack(id, chunks).catch(onError);
  };

  const answerAll = () => {
    answering = null;
    const due = [...owed];
    owed.clear();
    for (const [id, chunks] of due) answer(id, chunks);
  };

  /** One more chunk of `id` off the channel: answered with its batch, or by the timer. */
  const took = (id: string) => {
    const chunks = (owed.get(id) ?? 0) + 1;
    if (chunks < ACK_BATCH) {
      owed.set(id, chunks);
      answering ??= setTimeout(answerAll, ACK_DELAY_MS);
      return;
    }
    owed.delete(id);
    answer(id, chunks);
    if (owed.size === 0 && answering !== null) {
      clearTimeout(answering);
      answering = null;
    }
  };

  /**
   * The channel's handler. It must never throw: Tauri's channel counts a
   * message as delivered only once this returns, so a throw would hold back
   * every later message, for every terminal on the page, for good.
   */
  const deliver = (message: unknown) => {
    const m = read(message, decoder);
    if (!m) {
      onError(new Error("unreadable message on the PTY channel"));
      return;
    }
    const [kind, payload]: [PtyTopic["kind"], unknown] =
      "output" in m
        ? ["output", { data: m.output.data }]
        : "exit" in m
          ? ["exit", m.exit]
          : "activity" in m
            ? ["activity", m.activity]
            : ["idle", m.idle];
    // Answered for whether anyone listens: what the count bounds is what
    // sits in the bridge, and this chunk has left it.
    if ("output" in m) took(m.output.id);
    // Exactly the subscriptions the backend named when it sent this, minus
    // any that let go since: the event bus's own rule (its listener ids were
    // fixed at emit time, and the page skipped the ones already gone). One
    // payload object for all of them, as the bus shared its `payload`.
    for (const sub of m.to) {
      const entry = entries.get(sub);
      if (!entry || entry.kind !== kind) continue;
      try {
        (entry.cb as (p: unknown) => void)(payload);
      } catch (error) {
        onError(error);
      }
    }
  };

  /** The page link, opened once. One that failed to open is forgotten, so the next subscription tries again. */
  const opened = () => {
    if (!link) {
      const opening = port.open(deliver);
      link = opening;
      opening.catch(() => {
        if (link === opening) link = null;
      });
    }
    return link;
  };

  /**
   * Numbers the subscription, puts its listener in place, waits until the
   * backend holds it, and returns its unlisten. The number and the listener
   * come first, as `listen` made its callback before asking the backend: a
   * message sent the moment the backend registers it can arrive before the
   * answer does, and must find its listener already there.
   */
  const subscribe = async <T>(topic: PtyTopic, cb: (p: T) => void): Promise<Unlisten> => {
    const sub = ++lastSub;
    entries.set(sub, { kind: topic.kind, cb });
    let at: number;
    try {
      at = await opened();
      await port.subscribe(at, sub, topic);
    } catch (error) {
      entries.delete(sub);
      throw error;
    }
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      entries.delete(sub);
      void port.unsubscribe(at, sub).catch(onError);
    };
  };

  return {
    output: (id, cb) => subscribe({ kind: "output", id }, cb),
    exit: (id, cb) => subscribe({ kind: "exit", id }, cb),
    activity: (id, cb) => subscribe({ kind: "activity", id }, cb),
    idle: (cb) => subscribe({ kind: "idle" }, cb),
  };
}
