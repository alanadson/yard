/**
 * Two callers asking in the same turn of the event loop are asking one
 * question, and share one read (the stores lean on that: two refreshes fired
 * by one gesture cost one IPC hop). A caller asking after the read is already
 * under way is a newer question: whatever that read is about to return is
 * behind it. Handing back the pending promise and stopping there meant a
 * change that landed mid-read was never seen until something else asked.
 */
import { expect, it, vi } from "vitest";

import { ReadCoordinator } from "./readCoordinator";

/** The regression: a run that arrived while one was pending never re-read. */
it("reads once more after the pending read settles when the same key is asked again later", async () => {
  const coordinator = new ReadCoordinator();
  const finish: Array<(value: number) => void> = [];
  const read = vi.fn(() => new Promise<number>((resolve) => { finish.push(resolve); }));
  const accepted: number[] = [];
  const accept = (value: number) => { accepted.push(value); };

  const first = coordinator.run("doc", "scope", read, accept, () => {});
  // A later turn: the file watcher fired while the read was on its way.
  await Promise.resolve();
  const second = coordinator.run("doc", "scope", read, accept, () => {});
  expect(read).toHaveBeenCalledTimes(1);

  finish[0](1);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  finish[1](2);
  await Promise.all([first, second]);

  expect(accepted).toEqual([1, 2]);
});

it("several later callers cost one re-read, not one each", async () => {
  const coordinator = new ReadCoordinator();
  const finish: Array<(value: number) => void> = [];
  const read = vi.fn(() => new Promise<number>((resolve) => { finish.push(resolve); }));
  const accepted: number[] = [];
  const accept = (value: number) => { accepted.push(value); };

  const first = coordinator.run("doc", "scope", read, accept, () => {});
  await Promise.resolve();
  const later = [1, 2].map(() => coordinator.run("doc", "scope", read, accept, () => {}));
  finish[0](1);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  finish[1](2);
  await Promise.all([first, ...later]);

  expect(read).toHaveBeenCalledTimes(2);
  expect(accepted).toEqual([1, 2]);
});

it("callers asking in the same turn share one read and get one answer", async () => {
  const coordinator = new ReadCoordinator();
  let finish!: (value: number) => void;
  const read = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
  const accepted: number[] = [];
  const accept = (value: number) => { accepted.push(value); };

  const runs = [1, 2].map(() => coordinator.run("doc", "scope", read, accept, () => {}));
  finish(1);
  await Promise.all(runs);

  expect(read).toHaveBeenCalledTimes(1);
  expect(accepted).toEqual([1]);
});

it("an invalidated key drops the pending value and does not re-read", async () => {
  const coordinator = new ReadCoordinator();
  let finish!: (value: number) => void;
  const read = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
  const accepted: number[] = [];

  const first = coordinator.run("doc", "scope", read, (v) => accepted.push(v), () => {});
  await Promise.resolve();
  coordinator.run("doc", "scope", read, (v) => accepted.push(v), () => {});
  coordinator.invalidate("doc");
  finish(1);
  await first;

  expect(read).toHaveBeenCalledTimes(1);
  expect(accepted).toEqual([]);
});
