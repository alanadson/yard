/**
 * The fold record is what `editorStore` writes to the kv for the whole
 * workspace, and it outlives every version of the app that wrote it. It lives
 * in a module of its own, with no CodeMirror in it, because the store sits on
 * the boot path and must not drag the editor into the startup chunk
 * (`src/main.test.ts` locks that). Moving it is only safe if nothing about it
 * moved: the bytes it writes, what it accepts back, and which folds survive a
 * file that changed.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_FOLDS,
  parseFoldRecord,
  parseFolds,
  serializeFoldRecord,
  validFolds,
} from "./foldRecord";

describe("the fold record, byte for byte", () => {
  it("writes exactly what earlier versions wrote", () => {
    const record = {
      "C:/r::a.ts": [
        { from: 10, to: 20 },
        { from: 60, to: 80 },
      ],
      "C:/r::b.ts": [],
      "C:/r::c.md": [{ from: 0, to: 5 }],
    };

    expect(serializeFoldRecord(record)).toBe('{"C:/r::a.ts":"10-20,60-80","C:/r::c.md":"0-5"}');
  });

  it("reads back a record an earlier version wrote", () => {
    expect(parseFoldRecord('{"C:/r::a.ts":"10-20,60-80","C:/r::b.ts":""}')).toEqual({
      "C:/r::a.ts": [
        { from: 10, to: 20 },
        { from: 60, to: 80 },
      ],
    });
  });

  it("has no record at all for a workspace that was never read", () => {
    expect(parseFoldRecord(undefined)).toEqual({});
  });
});

describe("what comes back from disk", () => {
  it("tolerates spaces around a piece and skips a negative or fractional one", () => {
    expect(parseFolds(" 10-20 , -5-9, 1.5-3,30-40")).toEqual([
      { from: 10, to: 20 },
      { from: 30, to: 40 },
    ]);
  });

  it("keeps the first folds of the document, not the first ones listed", () => {
    // Sorting before cutting: a record listed backwards must not restore the
    // folds at the bottom of the file and drop the ones at the top.
    const backwards = Array.from({ length: MAX_FOLDS + 10 }, (_, i) => {
      const n = MAX_FOLDS + 10 - i;
      return { from: n * 10, to: n * 10 + 5 };
    });

    const kept = validFolds(backwards, 100_000);

    expect(kept).toHaveLength(MAX_FOLDS);
    expect(kept[0]).toEqual({ from: 10, to: 15 });
    expect(kept[MAX_FOLDS - 1]).toEqual({ from: MAX_FOLDS * 10, to: MAX_FOLDS * 10 + 5 });
  });
});
