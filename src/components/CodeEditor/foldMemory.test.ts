/**
 * Folds that survive closing the app.
 *
 * A fold is the reader saying "not this part, not today", and until now that
 * statement lasted exactly as long as the window did. Persisting it means
 * writing offsets into the same record the open tabs live in, and offsets are
 * a promise about a file that anyone, an agent, a rebase, a formatter, may
 * have rewritten while the app was closed. So the rule is: restore what still
 * fits the document in front of us, and quietly drop what does not. A fold
 * restored onto the wrong range hides code the reader never asked to hide,
 * which is the one failure here that is worse than forgetting.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_FOLDS,
  parseFoldRecord,
  parseFolds,
  serializeFoldRecord,
  serializeFolds,
  validFolds,
} from "./foldMemory";

describe("validFolds", () => {
  it("keeps a fold the document still has room for", () => {
    expect(validFolds([{ from: 10, to: 40 }], 100)).toEqual([{ from: 10, to: 40 }]);
  });

  it("drops a fold that runs past the end of the file", () => {
    // The file shrank while the app was closed.
    expect(validFolds([{ from: 10, to: 400 }], 100)).toEqual([]);
  });

  it("drops a fold that folds nothing", () => {
    expect(validFolds([{ from: 40, to: 40 }], 100)).toEqual([]);
    expect(validFolds([{ from: 40, to: 10 }], 100)).toEqual([]);
  });

  it("drops a fold that starts before the file does", () => {
    expect(validFolds([{ from: -3, to: 20 }], 100)).toEqual([]);
  });

  it("puts the folds in document order", () => {
    const folds = [
      { from: 60, to: 80 },
      { from: 10, to: 20 },
    ];

    expect(validFolds(folds, 100)).toEqual([
      { from: 10, to: 20 },
      { from: 60, to: 80 },
    ]);
  });

  it("stops after a sane number of them", () => {
    const many = Array.from({ length: MAX_FOLDS + 10 }, (_, i) => ({
      from: i * 10,
      to: i * 10 + 5,
    }));

    expect(validFolds(many, 100_000)).toHaveLength(MAX_FOLDS);
  });
});

describe("serializeFolds and parseFolds", () => {
  it("writes and reads back the same folds", () => {
    const folds = [
      { from: 10, to: 20 },
      { from: 60, to: 80 },
    ];

    expect(parseFolds(serializeFolds(folds))).toEqual(folds);
  });

  it("has nothing to write for a file with no folds", () => {
    expect(serializeFolds([])).toBe("");
  });

  it("survives a record written by an older version, or by nobody", () => {
    // This string comes off disk. It has to be treated as input, not as data
    // we wrote: a crash while restoring tabs costs the user every draft.
    expect(parseFolds("")).toEqual([]);
    expect(parseFolds("garbage")).toEqual([]);
    expect(parseFolds("10-20,nonsense,60-80")).toEqual([
      { from: 10, to: 20 },
      { from: 60, to: 80 },
    ]);
  });
});


describe("the record on disk", () => {
  it("writes and reads back the folds of every open file", () => {
    const record = { "C:/r::a.ts": [{ from: 10, to: 20 }], "C:/r::b.ts": [] };

    expect(parseFoldRecord(serializeFoldRecord(record))).toEqual({
      "C:/r::a.ts": [{ from: 10, to: 20 }],
    });
  });

  it("writes nothing when nothing is folded", () => {
    expect(serializeFoldRecord({})).toBe("");
    expect(parseFoldRecord("")).toEqual({});
  });

  it("survives a record nobody here wrote", () => {
    expect(parseFoldRecord("not json")).toEqual({});
    expect(parseFoldRecord("[1,2]")).toEqual({});
    expect(parseFoldRecord('{"a":42}')).toEqual({});
  });
});
