/**
 * The Ctrl+Shift+<letter> chords of the window, as one table. The regression
 * this locks down: `Ctrl+Shift+T` had two branches in the key handler, and
 * the first (the editor's own reopen) shadowed the second (`reopenLastTab`,
 * which also restores browser tabs), so a closed browser tab never came back.
 * A table cannot hold two entries for the same key.
 */
import { describe, expect, it } from "vitest";

import { shiftLetterChord } from "./shiftLetterChord";

const chord = (code: string, extra: Partial<Parameters<typeof shiftLetterChord>[0]> = {}) => ({
  ctrlKey: true,
  metaKey: false,
  shiftKey: true,
  altKey: false,
  code,
  ...extra,
});

describe("shiftLetterChord", () => {
  it("Ctrl+Shift+T reopens the last closed tab, files and browsers alike", () => {
    expect(shiftLetterChord(chord("KeyT"))).toBe("reopenLastTab");
  });

  it("without Shift or without Ctrl there is no chord", () => {
    expect(shiftLetterChord(chord("KeyT", { shiftKey: false }))).toBeNull();
    expect(shiftLetterChord(chord("KeyT", { ctrlKey: false }))).toBeNull();
  });

  it("Cmd stands in for Ctrl", () => {
    expect(shiftLetterChord(chord("KeyT", { ctrlKey: false, metaKey: true }))).toBe("reopenLastTab");
  });

  it("a letter with no chord is nobody's", () => {
    expect(shiftLetterChord(chord("KeyZ"))).toBeNull();
  });
});
