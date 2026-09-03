/**
 * The board's keys, rebindable. What has to hold: a chord is spelled the
 * same way on the way in (a key event) and on the way out (a label in
 * Settings), an override replaces exactly one default, junk in the kv is
 * ignored rather than shadowing a key, and two actions on one chord are
 * reported instead of silently racing.
 */
import { describe, expect, it } from "vitest";

import {
  actionFor,
  chordFromEvent,
  chordLabel,
  conflicts,
  DEFAULT_KEYMAP,
  normalizeKeymap,
  parseChordLabel,
  resolveKeymap,
  sameChord,
} from "./keymap";

const ev = (code: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("chords", () => {
  it("reads a key event, with Meta counting as Ctrl", () => {
    expect(chordFromEvent(ev("KeyT", { ctrl: true, shift: true }))).toEqual({
      key: "KeyT",
      ctrl: true,
      shift: true,
    });
    expect(chordFromEvent(ev("KeyV", { meta: true }))).toEqual({ key: "KeyV", ctrl: true });
  });

  it("labels and parses the same spelling", () => {
    expect(chordLabel({ key: "KeyT", ctrl: true, shift: true })).toBe("Ctrl+Shift+T");
    expect(chordLabel({ key: "Digit1", shift: true })).toBe("Shift+1");
    expect(chordLabel({ key: "F2" })).toBe("F2");
    expect(chordLabel({ key: "Equal", ctrl: true })).toBe("Ctrl+=");
    for (const label of ["Ctrl+Shift+T", "Shift+1", "F2", "V", "Ctrl+=", "Alt+M"]) {
      expect(chordLabel(parseChordLabel(label)!)).toBe(label);
    }
  });

  it("refuses a label with no key, or a key it cannot name", () => {
    expect(parseChordLabel("Ctrl+")).toBeNull();
    expect(parseChordLabel("")).toBeNull();
    expect(parseChordLabel("Ctrl+Fnord")).toBeNull();
  });

  it("compares chords by content", () => {
    expect(sameChord({ key: "KeyV" }, { key: "KeyV", ctrl: false })).toBe(true);
    expect(sameChord({ key: "KeyV" }, { key: "KeyV", shift: true })).toBe(false);
  });
});

describe("the map", () => {
  it("finds the action a key event means, with the defaults", () => {
    const map = resolveKeymap({});
    expect(actionFor(map, ev("KeyV"))).toBe("tool.select");
    expect(actionFor(map, ev("KeyT", { ctrl: true, shift: true }))).toBe("tidy");
    expect(actionFor(map, ev("KeyZ", { ctrl: true }))).toBe("undo");
    expect(actionFor(map, ev("KeyZ", { ctrl: true, shift: true }))).toBe("redo");
    expect(actionFor(map, ev("KeyQ"))).toBeNull();
  });

  it("an override replaces one default and frees the old key", () => {
    const map = resolveKeymap({ "tool.pen": { key: "KeyB" } });
    expect(actionFor(map, ev("KeyB"))).toBe("tool.pen");
    expect(actionFor(map, ev("KeyP"))).toBeNull();
    expect(map["tool.select"]).toEqual(DEFAULT_KEYMAP["tool.select"]);
  });

  it("an action can be switched off with null", () => {
    const map = resolveKeymap({ "tool.flow": null });
    expect(actionFor(map, ev("KeyF"))).toBeNull();
  });

  it("junk from the kv is ignored, key by key", () => {
    const over = normalizeKeymap({
      "tool.pen": { key: "KeyB" },
      "tool.rect": { key: 42 },
      "not.an.action": { key: "KeyX" },
      "tool.note": "N",
      "tool.flow": null,
    });
    expect(over).toEqual({ "tool.pen": { key: "KeyB" }, "tool.flow": null });
    expect(normalizeKeymap("junk")).toEqual({});
  });

  it("reports two actions on one chord", () => {
    const map = resolveKeymap({ "tool.pen": { key: "KeyV" } });
    expect(conflicts(map)).toEqual([["tool.select", "tool.pen"]]);
    expect(conflicts(resolveKeymap({}))).toEqual([]);
  });
});
