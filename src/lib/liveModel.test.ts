/**
 * `reduceFeed` promises a new model and an untouched `base`. The overlay, the
 * shoulder digest and the transcript all fold events over models they keep
 * for themselves; a reducer that bumped a file's counters on the shared entry
 * made one reader count the edits of the others.
 */
import { expect, it } from "vitest";

import type { FeedEvent } from "./ipc";
import { emptyFeedModel, localIds, reduceFeed } from "./liveModel";

const edit = (at: number): FeedEvent => ({
  kind: "tool",
  at,
  op: "edit",
  path: "src/a.ts",
  added: 1,
  removed: 0,
});

/**
 * The regression this locks down: the files map was copied shallowly and the
 * entry inside it was mutated, so `base` saw the second edit as its own.
 */
it("leaves the base model's file entry untouched when folding another edit on the same file", () => {
  const base = reduceFeed(emptyFeedModel(), [edit(1)], localIds());
  const next = reduceFeed(base, [edit(2)], localIds());
  expect(next.files["src/a.ts"].edits).toBe(2);
  expect(base.files["src/a.ts"].edits).toBe(1);
  expect(base.files["src/a.ts"].lastAt).toBe(1);
});
