/**
 * Why these rules matter: the queue writes into a live PTY on its own, with
 * nobody watching. Everything that keeps that from being frightening is a
 * rule in `queue.ts` — one item at a time per terminal, in the order it was
 * asked, never while the CLI is mid-answer or sitting on a permission prompt,
 * and never twice.
 *
 * The delivery itself (who is ready, `injectPrompt`) is in `hooks/useQueue.ts`;
 * here there is no store, no IPC and no clock of its own.
 */
import { describe, expect, it } from "vitest";

import {
  QUEUE_CAP,
  appended,
  dueItems,
  moved,
  pendingFor,
  withoutId,
  withoutTerminal,
  type QueueItem,
} from "./queue";

const item = (id: string, terminalId: string, at = 0): QueueItem => ({
  id,
  terminalId,
  text: `prompt ${id}`,
  at,
  source: "user",
});

describe("pendingFor", () => {
  const items = [item("1", "a"), item("2", "b"), item("3", "a")];

  it("keeps a terminal's items in the order they were asked", () => {
    expect(pendingFor(items, "a").map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("answers with nothing for a terminal with nothing waiting", () => {
    expect(pendingFor(items, "c")).toEqual([]);
  });
});

describe("appended", () => {
  it("puts the new item at the back", () => {
    const { items } = appended([item("1", "a")], item("2", "a"));
    expect(items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  /**
   * The cap is per terminal, not global: six agents each with a few queued
   * prompts is a normal Tuesday, and one runaway agent must not spend
   * everyone else's room.
   */
  it("caps each terminal on its own", () => {
    const full = Array.from({ length: QUEUE_CAP }, (_, i) => item(`a${i}`, "a"));
    const rejected = appended(full, item("mais", "a"));
    expect(rejected.full).toBe(true);
    expect(rejected.items).toHaveLength(QUEUE_CAP);

    const other = appended(full, item("b1", "b"));
    expect(other.full).toBe(false);
    expect(other.items).toHaveLength(QUEUE_CAP + 1);
  });
});

describe("removing", () => {
  const items = [item("1", "a"), item("2", "b"), item("3", "a")];

  it("takes one item out by id", () => {
    expect(withoutId(items, "2").map((i) => i.id)).toEqual(["1", "3"]);
  });

  /** A card closed, a process killed for good: the queue goes with it. */
  it("empties a whole terminal at once", () => {
    expect(withoutTerminal(items, "a").map((i) => i.id)).toEqual(["2"]);
  });

  it("leaves the list alone when the id is not there", () => {
    expect(withoutId(items, "nao-existe")).toHaveLength(3);
  });
});

describe("moved", () => {
  const items = [item("1", "a"), item("2", "b"), item("3", "a"), item("4", "a")];

  it("moves an item up among its own terminal's items, not the whole list", () => {
    expect(moved(items, "3", -1).map((i) => i.id)).toEqual(["3", "2", "1", "4"]);
  });

  it("moves it down the same way", () => {
    expect(moved(items, "1", 1).map((i) => i.id)).toEqual(["3", "2", "1", "4"]);
  });

  it("does nothing at the ends", () => {
    expect(moved(items, "1", -1).map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
    expect(moved(items, "4", 1).map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("dueItems", () => {
  const items = [item("1", "a"), item("2", "a"), item("3", "b")];

  /**
   * The regression this exists to prevent: sending everything a terminal has
   * queued the moment it goes quiet. Two prompts pasted back to back are one
   * garbled prompt — the second has to wait for the CLI to be idle *again*.
   */
  it("releases one item per terminal, never the whole queue", () => {
    const due = dueItems(items, () => true);
    expect(due.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("releases nothing for a terminal that is not ready", () => {
    const due = dueItems(items, (id) => id === "b");
    expect(due.map((i) => i.id)).toEqual(["3"]);
  });

  it("releases nothing at all when nobody is ready", () => {
    expect(dueItems(items, () => false)).toEqual([]);
  });

  it("has nothing to release from an empty queue", () => {
    expect(dueItems([], () => true)).toEqual([]);
  });
});
