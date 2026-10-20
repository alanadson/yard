/** Native acknowledgements must preserve prompts added while another queue write was pending. */
import { expect, it } from "vitest";
import * as patch from "./queuePatch";
import type { QueueItem } from "./queue";

const item = (id: string): QueueItem => ({ id, terminalId: "agent", text: `Request ${id}`, at: 1_000, source: "user" });

it("changes queue references only for acknowledged content changes", () => {
  const pending = item("pending");
  const sending: QueueItem = { ...item("sending"), delivery: { status: "sending", attemptedAt: 2_000 } };
  const current = [pending, sending];
  const snapshot = structuredClone(current);
  expect(patch.mergeQueueAcknowledgement(current, current, current, snapshot)).toBe(current);

  snapshot[1].delivery!.owner = "native";
  const changed = patch.mergeQueueAcknowledgement(current, current, current, snapshot);
  expect(changed).not.toBe(current);
  expect(changed[0]).toBe(pending);
  expect(changed[1].delivery?.owner).toBe("native");
});

it("applies an acknowledged removal while keeping later local prompts and previously unseen native tasks", () => {
  const delivered = item("delivered");
  const added = item("local-added");
  const native = item("native-task");
  expect(patch.mergeQueueAcknowledgement([delivered, added], [delivered], [], [native])).toEqual([added, native]);
});

it("updates an unchanged local item from the native acknowledgement while preserving later local changes", () => {
  const pending = item("request");
  const reserved = { ...pending, delivery: { status: "sending" as const, attemptedAt: 2_000 } };
  expect(patch.mergeQueueAcknowledgement([pending], [pending], [pending], [reserved])).toEqual([reserved]);
  const reviewed = { ...reserved, delivery: { status: "uncertain" as const, attemptedAt: 2_000 } };
  expect(patch.mergeQueueAcknowledgement([reviewed], [pending], [reserved], [reserved])).toEqual([reviewed]);
});

it("follows acknowledged FIFO order unless the user reordered that terminal while the request was pending", () => {
  const first = item("first");
  const last = item("last");
  const unseen = item("native-task");
  expect(patch.mergeQueueAcknowledgement([first, last], [first, last], [first, last], [first, unseen, last])).toEqual([first, unseen, last]);
  expect(patch.mergeQueueAcknowledgement([last, first], [first, last], [first, last], [first, unseen, last])).toEqual([last, first, unseen]);
});
